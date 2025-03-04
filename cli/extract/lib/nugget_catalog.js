'use strict'
const assert = require('assert')
const { aql, join } = require('arangojs/aql')
const { Nugget } = require('../../lib/nugget')
const TreeModel = require('tree-model')

exports.NuggetCatalog = class NuggetCatalog {
  static HEADING_RE = /^(#+)\s+(.+)$/gm

  constructor (db, includes = [], excludes = [], minLength) {
    this.db = db
    this.includes = includes
    this.excludes = excludes
    this.minLength = minLength
    this.allNuggets = {}
    this.seamNuggetChunks = {}
    this.initialised = false

    this.filters = []
    this.includes.forEach(inc => this.filters.push(
      aql`FILTER v.${inc.key} == ${inc.value}`
    ))
    this.excludes.forEach(exc => this.filters.push(
      aql`FILTER v.${exc.key} != ${exc.value}`
    ))
  }

  // return the aql-joined filters
  getFilters () {
    return join(this.filters)
  }

  async init () {
    const cursor = await this.db.query(aql`
      FOR v, e, p IN 0..10000 OUTBOUND "passage/adit" GRAPH "primary"
        OPTIONS { uniqueVertices: "global", order: "weighted" }
        RETURN v
    `)

    // for now all nuggets are pulled into memory
    for await (const c of cursor) {
      this.allNuggets[c._key] = new Nugget(c)
    }

    this.initialised = true
  }

  // get an ordered array of markdown chunks with metadata
  async getOrdered () {
    // ordering is determined by walking the tree
    const treeRoot = await this.getTree()

    // put the files into the order defined by the tree
    const orderedChunks = []

    treeRoot.walk((node) => {
      // empty passage leaf nodes are skipped
      if (!node.model.body && !node.hasChildren() && node.model._id.startsWith('passage')) {
        return true
      }

      const md = this.#mdForExtract(node.model._key, node.model.depth)
      if (md && this.#allowExtract(md)) {
        orderedChunks.push(this.rewriteHeadings(md, node.model.depth))
      }
      return true
    })
    return orderedChunks
  }

  // collate markdown chunks into pages based on passage
  async getPaged () {
    const treeRoot = await this.getTree()

    const toDrop = []

    // walk to generate chunks
    treeRoot.walk((node) => {
      // skip empty leaf nodes
      if (!node.hasChildren() && !('body' in node.model)) {
        toDrop.push(node)
        return true
      }
      const md = this.#mdForExtract(node.model._key, node.model.depth)
      if (md && this.#allowExtract(md)) {
        node.model.chunks.push(md)
      }
      return true
    })

    toDrop.forEach(d => d.drop())

    // collate nuggets up to their passage to make pages
    treeRoot.walk((node) => {
      if (node.parent) {
        const pMod = node.parent.model
        if (pMod.type === 'passage' &&
          !pMod.nuggets &&
          node.model.type === 'nugget' &&
          node.model.chunks.length > 0) {
          pMod.chunks.push(...node.model.chunks)
          node.model.chunks = []
        }
      }
      return true
    })

    // remove empty leaf nodes
    let len
    do {
      const emptyLeaves = treeRoot.all(n => !n.hasChildren() && n.model.chunks.length === 0)
      len = emptyLeaves.length
      emptyLeaves.forEach(n => n.drop())
    } while (len)

    return treeRoot
  }

  // get markdown chunks for seams then any non-seam nuggets
  populateChunks () {
    this.initCheck()

    const nugList = []

    // create a markdown chunk for each seam
    for (const seam of Object.values(this.allNuggets).filter(s => s.nuggets)) {
      const seamBody = this.getMd('', seam._key)
      this.seamNuggetChunks[seam._key] = seam.nuggets.reduce((acc, key) => this.getMd(acc, key), seamBody)
      nugList.push(seam._key, ...seam.nuggets)
    }

    // create a lookup of all nuggets written so far
    const writtenNugs = nugList.reduce((acc, cur) => { acc[cur] = 1; return acc }, {})

    // create a markdown chunk for each nugget not already written
    for (const nugget of Object.values(this.allNuggets).filter(n => !(n._key in writtenNugs))) {
      if (!nugget.body) continue
      this.seamNuggetChunks[nugget._key] = nugget.body
    }
  }

  // pull just the markdown from the ordered chunks
  async getSeamNuggetMarkdown () {
    this.populateChunks()
    return await this.getOrdered()
  }

  // pull ordered chunks with model metadata included
  async getSeamNuggetTree () {
    this.populateChunks()
    return await this.getPaged()
  }

  #mdForExtract (key, depth) {
    const nug = this.allNuggets[key]
    if (!nug) return undefined // has been filtered out

    let retMd

    if (key in this.seamNuggetChunks) {
      retMd = this.seamNuggetChunks[key]
    } else if (nug._id.startsWith('passage')) {
      if (nug.body) {
        retMd = nug.body
      } else {
        // create a heading when there's no nugget body
        // TODO remove elipses
        retMd = `${'#'.repeat(depth)} ${nug.label}\n`
      }
    }

    if (retMd) {
      // create header if there wasn't one
      if (!retMd.match(NuggetCatalog.HEADING_RE)) {
        return `${'#'.repeat(depth)} ${nug.label}\n\n${retMd}`
      }
      return retMd
    }

    return undefined
  }

  #allowExtract (markdown) {
    return markdown.replace(NuggetCatalog.HEADING_RE, '').length > this.minLength
  }

  // heading depths/levels are taken from the graph depth and overwritten in the output
  // markdown, which ensures the TOC is well ordered
  rewriteHeadings (markdown, depth) {
    const MAX = 6
    depth = (depth > MAX) ? MAX : depth

    const matches = Array.from(markdown.matchAll(NuggetCatalog.HEADING_RE))

    if (matches.length) {
      let last = depth

      // the depth of each heading depends on the number of hashes
      const depths = matches.map(m => m[1].length)

      // create new heading depths based on passed-in depth and other limits
      const newHeads = depths.map(l => l - depths[0] + depth)
        // cannot go over the maximum allowed depth
        .map(l => l > MAX ? MAX : l)
        // do not allow a higher level heading than the first in the page
        .map(l => l < depth ? depth : l)
        // make sure the level only increases by one at a time
        .map(l => {
          const ret = (l > last + 1) ? last + 1 : l
          last = l
          return ret
        })
        // turn the lengths into strings of hashes
        .map(l => '#'.repeat(l))

      // replace the previously matched headings using replacer function
      let idx = 0
      return markdown.replace(NuggetCatalog.HEADING_RE,
        (match, p1, p2) => [newHeads[idx++], p2].join(' '))
    }

    // markdown given to this function must have headers
    // just return it -- might change this to a throw later
    return markdown
  }

  initCheck () {
    if (!this.initialised) {
      throw new Error('must call init() first')
    }
  }

  // get the markdown for the given nugget _key
  getMd (acc, key) {
    // nuggets could be filtered out so just return the accumulator
    if (!(key in this.allNuggets)) return acc

    const parts = [acc]
    parts.push(this.allNuggets[key].body)
    return parts.join('\n')
  }

  // turn '|' separated path strings into a TreeModel, which will allow
  // operations like sorting on the tree later
  async getTree () {
    // TODO dedupe of secondary edges
    const cursor = await this.db.query(aql`
      FOR v, e, p IN 0..10000 OUTBOUND 'passage/adit' GRAPH 'primary'
        ${join(this.filters)}
        RETURN { keys: CONCAT_SEPARATOR("|", p.vertices[*]._key), nug: LAST(p.vertices[*]) }
    `)

    // TreeModel will sort in the same way as a Nugget list
    const tree = new TreeModel({ modelComparatorFn: Nugget.compare })
    const root = tree.parse({ depth: 0, chunks: [], ...this.allNuggets.adit })

    for await (const c of cursor) {
      let current = root
      let depth = 1

      // go over keys in path adding any child nodes that do not exist yet
      for (const key of c.keys.split('|')) {
        const node = current.first(n => n.model._key === key)
        if (node) {
          current = node // key already added on prior iteration
        } else {
          const nugget = this.allNuggets[key]
          assert.ok(nugget)
          current = current.addChild(tree.parse({ depth, chunks: [], ...nugget }))
        }
        depth++
      }
    }
    return root
  }

  getChunk (key, depth) {
    const md = this.#mdForExtract(key, depth)
    if (!md) return
    return this.rewriteHeadings(md, depth)
  }
}
