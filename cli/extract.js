'use strict'
const { statSync, writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { Database } = require('arangojs')
const { aql } = require('arangojs/aql')
const ncp = require('ncp').ncp
const mustache = require('mustache')
const util = require('util')
const ncpp = util.promisify(ncp)
const { MineMap } = require('./extract/lib/minemap')
const { Nugget } = require('./lib/nugget')
const { confluencePages } = require('./extract/confluence/pages')
const log = require('loglevel')

log.setLevel('WARN')

exports.command = 'extract <format> <mine> [<sitecustom>] [<directory>]'

exports.describe = 'Extract the data from a mine into some output format'

exports.builder = (yargs) => {
  return yargs
    .positional('format', {
      describe: 'The output format of the extraction',
      string: true,
      choices: ['gatsby', 'confluence']
    })
    .positional('mine', {
      describe: 'The name of the mine to extract',
      string: true
    })
    .positional('sitecustom', {
      describe: 'A JSON file for site customizations',
      string: true,
      normalize: true,
      coerce: f => {
        try {
          if (!statSync(f).isFile()) throw new Error('not a file')
          return JSON.parse(readFileSync(f, 'utf8'))
        } catch (err) {
          throw new Error(`${f} cannot be read [${err}]`)
        }
      }
    })
    .positional('directory', {
      describe: 'Target directory into which to extract the data',
      string: true,
      normalize: true,
      coerce: d => {
        try {
          if (!statSync(d).isDirectory()) throw new Error()
        } catch {
          throw new Error(`${d} is not a directory`)
        }
        return d
      }
    })
    .option('build', {
      type: 'boolean',
      default: true,
      description: 'Run the build (use --no-build to not)'
    })
    .option('spacekey', {
      type: 'string',
      description: 'Confluence space key',
      alias: 'k'
    })
    .option('pageid', {
      type: 'integer',
      description: 'ID of confluence page where mine will be extracted to',
      alias: 'p'
    })
    .check((argv) => {
      if (argv.format === 'gatsby' && (!argv.sitecustom || !argv.directory)) {
        return 'Both <sitecustom> and <directory> are requred for gatsby'
      } else if (argv.format === 'confluence') {
        if (!argv.spacekey) return 'confluence requires --spacekey'
        if (!argv.pageid) return 'confluence requires --pageid'
      }
      return true
    })
}

exports.handler = async function (argv) {
  try {
    if (argv.verbose) log.setLevel('INFO')

    const conf = { databaseName: argv.mine }
    if (process.env.ARANGO_URL) conf.url = process.env.ARANGO_URL

    const db = new Database(conf)
    if (!await db.exists()) {
      throw new Error(`mine ${argv.mine} does not exist`)
    }

    if (argv.format === 'gatsby') {
      log.info(`extracting to ${argv.directory}`)
      await copyTemplates(argv.directory, argv.sitecustom)
      await extractNuggets(db, argv.directory)
      await generateMineMap(db, argv.directory)
      if (argv.build) buildSite(argv.directory)
    } else if (argv.format === 'confluence') {
      confluencePages(db, argv)
    }
  } catch (err) {
    log.error(`ERROR: ${err}`)
    process.exit(1)
  }
}

async function copyTemplates (dir, customizations) {
  // copy and transform template layout to target directory
  log.info(`copy template files to target directory ${dir}`)
  const templateDir = join(__dirname, 'extract', 'gatsby')

  const options = {
    transform: function (read, write) {
      let template = ''
      read.on('data', function (chunk) {
        template += chunk
      })
      read.on('end', function () {
        const output = mustache.render(template, customizations)
        write.write(output)
        write.end()
      })
    }
  }

  await ncpp(templateDir, dir, options)
}

async function extractNuggets (db, dir) {
  const contentDir = join(dir, 'content')
  const nuggetStash = {}

  // pull each nugget type into a stash of Nugget objects
  log.info('extracting passages')
  const pcursor = await db.query(aql`FOR p IN passage FILTER p.passage RETURN p`)
  for await (const p of pcursor) {
    nuggetStash[p._id] = new Nugget(p, p.body)
  }

  log.info('extracting nuggets')
  const ncursor = await db.query(aql`FOR n IN nugget RETURN n`)
  for await (const n of ncursor) {
    nuggetStash[n._id] = new Nugget(n, n.body)
  }

  // breadcrumbs!
  for (const [_id, nugget] of Object.entries(nuggetStash)) {
    // query the paths from the given vertex back to the adit
    const cursor = await db.query(aql`
      FOR v, e, p IN 1..100 INBOUND ${_id} GRAPH 'primary'
      FILTER v._id == 'passage/adit'
      RETURN REVERSE(
        FOR vertex IN p.vertices[*]
        RETURN { _id: vertex._id, label: vertex.label, _key: vertex._key }
      )
    `)
    const breadcrumbs = []
    for await (const c of cursor) {
      // filter out the adit and self then push non-zero length paths into list
      const crumb = c.filter(b => b._id !== 'passage/adit' && b._id !== _id)
        .map(({ _id, ...rest }) => rest)

      if (crumb.length > 0) breadcrumbs.push(crumb)
    }
    nugget.breadcrumbs = breadcrumbs
  }

  // get all adjacent vertices for each nugget and write them to the slug
  for (const [_id, nugget] of Object.entries(nuggetStash)) {
    const cursor = await db.query(aql`
      FOR v, e IN 1..1 ANY ${_id} GRAPH 'primary'
      RETURN { v, e }
    `)

    const nuggetsOutbound = []
    const passagesOutbound = []
    const nuggetsInbound = []
    const passagesInbound = []

    for await (const c of cursor) {
      if (c.e._from === _id) {
        const nug = nuggetStash[c.e._to]
        if (nug.passage) passagesOutbound.push(nug)
        else nuggetsOutbound.push(nug)
      } else if (c.e._to === _id) {
        const nug = nuggetStash[c.e._from]
        if (nug.passage) passagesInbound.push(nug)
        else nuggetsInbound.push(nug)
      }
    }

    nuggetsOutbound.sort(Nugget.compare)
    passagesOutbound.sort(Nugget.compare)
    nuggetsInbound.sort(Nugget.compare)
    passagesInbound.sort(Nugget.compare)

    // collect up Nugget MDX to append to Seam component
    let append = ''
    if ('nuggets' in nugget) {
      append = nugget.nuggets.map(n => nuggetStash['nugget/' + n].getMdx({ inseam: true })).join('\n')
    }

    const slug = (nugget._key === 'adit') ? '/' : nugget._key

    const mdx = [
      nugget.getFrontMatter({ slug }),
      '<NuggetArea>',
      nugget.getMdx({ slug }, append),
      '<NuggetsInbound>',
      ...nuggetsInbound.map(v => v.getMdx({ direction: 'inbound' })),
      '</NuggetsInbound>',
      '<NuggetsOutbound>',
      ...nuggetsOutbound.map(v => v.getMdx({ direction: 'outbound' })),
      '</NuggetsOutbound>',
      '</NuggetArea>',
      '<PassagesInbound>',
      ...passagesInbound.map(v => v.getMdx({ direction: 'inbound' })),
      '</PassagesInbound>',
      '<PassagesOutbound>',
      ...passagesOutbound.map(v => v.getMdx({ direction: 'outbound' })),
      '</PassagesOutbound>'
    ]

    writeFileSync(join(contentDir, `${nugget._key}.mdx`), mdx.join('\n'))
  }
}

async function generateMineMap (db, dir) {
  const contentDir = join(dir, 'content')
  const mapFile = join(contentDir, 'minemap.json')

  const cursor = await db.query(aql`
    FOR v, e, p IN 1..100 OUTBOUND 'passage/adit' GRAPH 'primary'
      LET vertices = (
          FOR vertex IN p.vertices
              LET order_value = vertex.order == null ? 10000 : vertex.order
              RETURN MERGE(vertex, { order: order_value })
      )
      SORT vertices[*].order ASC, vertices[*].label ASC
      RETURN vertices
  `)

  const mm = new MineMap()
  for await (const p of cursor) {
    mm.addVerticies(p)
  }

  writeFileSync(mapFile, mm.toTree())
}

function buildSite (dir) {
  // assume npm is installed for now
  const manager = 'npm'

  try {
    log.info(`running npm install in ${dir}`)
    const stdout = execFileSync(manager, ['install'], { cwd: dir })
    log.info(stdout.toString())
  } catch (err) {
    log.error(err.stdout.toString())
    log.error(err.stderr.toString())
  }

  // gatsby build
  try {
    log.info(`running gatsby build in ${dir}`)
    const stdout = execFileSync(manager, ['run', 'deploy'], { cwd: dir })
    log.info(stdout.toString())
  } catch (err) {
    log.error(err.stdout.toString())
    log.error(err.stderr.toString())
    process.exit(1)
  }
}
