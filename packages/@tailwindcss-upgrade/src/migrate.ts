import fs from 'node:fs/promises'
import path from 'node:path'
import postcss, { AtRule } from 'postcss'
import postcssImport from 'postcss-import'
import { formatNodes } from './codemods/format-nodes'
import { migrateAtApply } from './codemods/migrate-at-apply'
import { migrateAtLayerUtilities } from './codemods/migrate-at-layer-utilities'
import { migrateMissingLayers } from './codemods/migrate-missing-layers'
import { migrateTailwindDirectives } from './codemods/migrate-tailwind-directives'
import { walk, WalkAction } from './utils/walk'

export interface Stylesheet {
  file?: string

  content?: string | null
  root?: postcss.Root | null
  layers?: string[]
  media?: string[]
  importRules?: AtRule[]
}

export async function migrateContents(stylesheet: Stylesheet | string) {
  if (typeof stylesheet === 'string') {
    stylesheet = {
      content: stylesheet,
      root: postcss.parse(stylesheet),
    }
  }

  return postcss()
    .use(migrateAtApply())
    .use(migrateAtLayerUtilities(stylesheet))
    .use(migrateMissingLayers())
    .use(migrateTailwindDirectives())
    .use(formatNodes())
    .process(stylesheet.root!, { from: stylesheet.file })
}

export async function migrate(stylesheet: Stylesheet) {
  if (!stylesheet.file) {
    throw new Error('Cannot migrate a stylesheet without a file path')
  }

  await migrateContents(stylesheet)
}

export async function analyze(stylesheets: Stylesheet[]) {
  let locationMarkers = new Set<postcss.Node>()
  let markers = new Set<postcss.Node>()

  let processor = postcss([
    {
      postcssPlugin: 'import-thing',
      Once(root) {
        root.walkAtRules('import', (node) => {
          let markerStart = postcss.comment({
            text: `import-marker-start: ${node.source?.input.file}`,
            raws: {
              file: node.source?.input.file,
              params: node.params,
            },
          })
          locationMarkers.add(markerStart)

          node.replaceWith([markerStart, node.clone()])
        })
      },
    },
    postcssImport({
      plugins: [
        {
          postcssPlugin: 'import-marker',
          Once(root) {
            let marker = postcss.comment({
              text: `imported-file-marker: ${root.source!.input.file}`,
              source: root.source,
            })
            markers.add(marker)
            root.prepend(marker)
          },
        },
      ],
    }),
  ])

  let stylesheetsByFile = new Map<string, Stylesheet>()
  for (let stylesheet of stylesheets) {
    if (!stylesheet.file) continue
    stylesheetsByFile.set(stylesheet.file, stylesheet)

    stylesheet.layers ??= []
    stylesheet.media ??= []
    stylesheet.importRules ??= []
  }

  // Run stylesheets through `postcss-import` and record dependencies
  for (let sheet of stylesheets) {
    if (!sheet.file) continue
    if (!sheet.root) continue

    await processor.process(sheet.root.clone(), { from: sheet.file })
  }

  // Associate the original `@import` node with each location marker
  for (let sheet of stylesheets) {
    if (!sheet.file) continue
    if (!sheet.root) continue

    sheet.root.walkAtRules('import', (atRule) => {
      let sourceFile = atRule.source?.input.file
      let params = atRule.params

      for (let marker of locationMarkers) {
        let markerFile = marker.raws.file
        let markerParams = marker.raws.params

        if (markerFile !== sourceFile) continue
        if (markerParams !== params) continue

        marker.raws.importRules ??= []
        marker.raws.importRules.push(atRule)
      }
    })
  }

  // Walk up the graph from every marker to record potential layer metadata
  for (let marker of markers) {
    let sourceFile = marker.source?.input.file
    if (!sourceFile) continue

    let stylesheet = stylesheetsByFile.get(sourceFile)
    if (!stylesheet) continue

    // Get the original at-rule that caused this import
    // let importLocationMarker = marker.prev()
    // if (importLocationMarker?.type !== 'comment') {
    //   throw new Error(marker.root().toString())

    //   // TODO: Can this actually ever happen idk?
    //   throw new Error('Expected a comment before the import marker')
    // }

    stylesheet.importRules!.push(...(importLocationMarker.raws.importRules as any))

    let node = marker

    while (node.parent) {
      let parent = node.parent
      if (parent.type === 'atrule') {
        let atRule = parent as postcss.AtRule

        if (atRule.name === 'layer') {
          stylesheet.layers!.push(atRule.params)
        } else if (atRule.name === 'media') {
          stylesheet.media!.push(atRule.params)
        }
      }

      node = parent
    }
  }
}

export async function prepare(stylesheet: Stylesheet) {
  if (stylesheet.file) {
    stylesheet.file = path.resolve(process.cwd(), stylesheet.file)
    stylesheet.content = await fs.readFile(stylesheet.file, 'utf-8')
  }

  if (stylesheet.content) {
    stylesheet.root = postcss.parse(stylesheet.content, {
      from: stylesheet.file,
    })
  }
}

export async function split(stylesheets: Stylesheet[]) {
  for (let sheet of stylesheets.slice()) {
    if (!sheet.root) continue
    if (!sheet.file) continue

    // We only care about stylesheets that were imported into a layer e.g. `layer(utilities)`
    let isLayered = sheet.layers?.includes('utilities') || sheet.layers?.includes('components')
    if (!isLayered) continue

    // We only care about stylesheets that contain an `@utility`
    let hasUtilities = false

    walk(sheet.root, (node) => {
      if (node.type !== 'atrule') return
      if (node.name !== 'utility') return

      hasUtilities = true

      return WalkAction.Stop
    })

    if (!hasUtilities) continue

    // Split the stylesheet into two parts: one with the utilities and one without
    let utilities = postcss.root()

    walk(sheet.root, (node) => {
      if (node.type !== 'atrule') return
      if (node.name !== 'utility') return

      utilities.append(node)

      return WalkAction.Skip
    })

    stylesheets.push({
      file: sheet.file.replace(/\.css$/, '.utilities.css'),
      root: utilities,
    })

    // Modify the import of this stylesheet to also import the new utilities stylesheet
    // this has to be done transitively so we might end up introducing additional stylesheets
    let imports = new Set<AtRule>()

    sheet.root.walkAtRules('import', (node) => {
      imports.add(node)
    })

    let processor = postcss([postcssImport()])

    for (let node of imports) {
      let root = postcss.root({ nodes: [node.clone()] })
      await processor.process(root, { from: sheet.file })
    }

    // sheet.parents
    // sheet.importNodes
  }

  return stylesheets
}
