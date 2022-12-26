'use strict'
const { statSync, existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { format } = require('node:util')
const { Database } = require('arangojs')
const { aql } = require('arangojs/aql')
const { copySync } = require('fs-extra')
const { MineMap } = require('./extract/lib/minemap')
const { Nugget } = require('../lib/nugget')
const log = require('loglevel')

log.setLevel('WARN')

exports.command = 'extract <format> <mine> <directory>'

exports.describe = 'Extract the data from a mine into some output format'

exports.builder = (yargs) => {
  return yargs
    .positional('format', {
      describe: 'The output format of the extraction',
      string: true,
      choices: ['gatsby']
    })
    .positional('mine', {
      describe: 'The name of the mine to extract',
      string: true
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
}

exports.handler = async function (argv) {
  try {
    if (argv.verbose) log.setLevel('INFO')

    const db = new Database({ databaseName: argv.mine })
    if (!await db.exists()) {
      throw new Error(`mine ${argv.mine} does not exist`)
    }

    log.info(`extracting to ${argv.directory}`)

    if (argv.format === 'gatsby') {
      copyTemplates(argv.directory)
      const nuggetData = await extractNuggets(db, argv.directory)
      const seamData = await extractSeams(db, nuggetData, argv.directory)
      await generateMineMap(db, nuggetData, seamData, argv.directory)
      if (argv.build) buildSite(argv.directory)
    }
  } catch (err) {
    log.error(`ERROR: ${err}`)
    process.exit(1)
  }
}

function copyTemplates (dir) {
  // copy template layout to target directory
  log.info(`copy template files to target directory ${dir}`)
  const templateDir = join(__dirname, 'extract', 'gatsby')
  copySync(templateDir, dir)
}

async function extractNuggets (db, dir) {
  const nuggetDir = join(dir, 'content', 'nuggets')

  log.info('extracting passages')
  writeNugs(await db.query(aql`FOR p IN passage FILTER p.passage RETURN p`))

  log.info('extracting nuggets')
  return writeNugs(await db.query(aql`FOR n IN nugget RETURN n`))

  async function writeNugs (cursor) {
    const nuggetData = {}
    for await (const nugget of cursor) {
      nuggetData[nugget._key] = nugget
      writeFileSync(
        join(nuggetDir, `${nugget._key}.mdx`),
        format('---\nslug: "%s"\nlabel: "%s"\n---\n%s',
          nugget._id.replace('passage', 'nugget'),
          Nugget.getLabel(nugget), getNuggetMdx(nugget))
      )
    }
    return nuggetData
  }
}

function getNuggetMdx (nugget) {
  return format(
    '<Nugget %s>\n%s\n</Nugget>\n',
    Object.keys(nugget).filter(n => n !== 'body').map(n => `${n}="${nugget[n]}"`).join(' '),
    nugget.body
  )
}

async function extractSeams (db, nuggetData, dir) {
  const seamDir = join(dir, 'content', 'seams')

  const cursor = await db.query(aql`
    FOR v, e, p IN 1..100 OUTBOUND 'passage/adit' GRAPH 'primary'
      FILTER IS_SAME_COLLECTION('seam', v)
      RETURN { vertex: LAST(p.vertices) }
  `)

  log.info('extracting seams')
  const seamData = {}

  for await (const v of cursor) {
    const seam = v.vertex
    seamData[seam._key] = seam
    writeFileSync(
      join(seamDir, `${seam._key}.mdx`),
      format('---\nslug: "%s"\nlabel: "%s"\n---\n%s',
        seam._id, Nugget.getLabel(seam), getSeamMdx(seam, nuggetData))
    )
  }

  return seamData
}

function getSeamMdx (seam, nuggetData) {
  let nuggets = ''

  if ('nuggets' in seam) {
    // this is duplicating nugget MDX into the seam, which may not be
    // ideal but doing a look-up within the template code is challenging
    nuggets = seam.nuggets.map(n => getNuggetMdx(nuggetData[n])).join('\n')
  }

  return format(
    '<Seam %s>\n%s\n%s\n</Seam>\n',
    Object.keys(seam).filter(s => s !== 'body').map(s => `${s}="${seam[s]}"`).join(' '),
    seam.body,
    nuggets
  )
}

async function generateMineMap (db, nuggetData, seamData, dir) {
  const contentDir = join(dir, 'content')
  const mapFile = join(contentDir, 'minemap.json')

  const cursor = await db.query(aql`
    FOR v, e, p IN 1..100 OUTBOUND 'passage/adit' GRAPH 'primary' RETURN p.vertices
  `)

  const mm = new MineMap()
  for await (const p of cursor) {
    mm.addVerticies(p)
  }

  writeFileSync(mapFile, mm.toTree())
}

function buildSite (dir) {
  const gatsby = join(__dirname, '..', 'node_modules', '.bin', 'gatsby')
  if (!existsSync(gatsby)) {
    log.error(`gatsby executable ${gatsby} does not exist`)
    process.exit(1)
  }

  // gatsby needs to be installed locally to the extract
  try {
    log.info(`running npm install in ${dir}`)
    const stdout = execFileSync('npm', ['install'], { cwd: dir })
    log.info(stdout.toString())
  } catch (err) {
    log.error(err.stdout.toString())
    log.error(err.stderr.toString())
  }

  // gatsby build
  try {
    log.info(`running gatsby build in ${dir}`)
    const stdout = execFileSync(gatsby, ['build'], { cwd: dir })
    log.info(stdout.toString())
  } catch (err) {
    log.error(err.stdout.toString())
    log.error(err.stderr.toString())
  }
}
