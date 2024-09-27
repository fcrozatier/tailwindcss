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
import { segment } from '../../tailwindcss/src/utils/segment'

export interface Stylesheet {
  file?: string

  content?: string | null
  root?: postcss.Root | null
  layers?: string[]

  parents?: Set<Stylesheet>
  importRules?: Set<AtRule>
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
  let mediaWrapper = `__wrapper__${Math.random().toString(16).slice(3, 8)}__`

  let stylesheetsByFile = new Map<string, Stylesheet>()
  for (let stylesheet of stylesheets) {
    if (!stylesheet.file) continue
    stylesheetsByFile.set(stylesheet.file, stylesheet)

    stylesheet.layers ??= []
    stylesheet.importRules ??= new Set()
    stylesheet.parents ??= new Set()
  }

  // A list of all marker nodes used to annotate and analyze the AST
  let importMarkers = new Set<postcss.Node>()
  let fileMarkers = new Set<postcss.Node>()

  let processor = postcss([
    // Step 1: Add markers around the `@import` rules
    //
    // We need to mark the start and end of each `@import` rule so we can
    // keep track of where they were in the original AST. We do this by cloning
    // the node, renaming the original, and adding start/end markers around it.
    {
      postcssPlugin: 'import-thing',
      Once(root) {
        let imports = new Set<AtRule>()

        root.walkAtRules('import', (node) => {
          imports.add(node)
        })

        for (let node of imports) {
          // Duplicate the `@import` rule
          // this will be the one that `postcss-import` processes
          node.cloneAfter({
            params: `${node.params} ${mediaWrapper}`
          })

          // Replace the original `@import` rule with a dummy comment
          // it'll retain the original node in `raws`
          let importMarker = postcss.comment({
            text: `__import_node__`,
            raws: { original: node },
          })

          importMarkers.add(importMarker)
          node.replaceWith(importMarker)
        }
      },
    },

    // Step 2: Expand `@import` rules and mark imported files
    //
    // Since valid imports are only at the top some files may not have any other
    // nodes we can use to determine where in the AST a file was imported. To
    // solve this, we'll add a marker at the top of each imported file which
    // guarantees that we have a way to determine where the file was imported.
    postcssImport({
      plugins: [
        {
          postcssPlugin: 'import-marker',
          Once(root) {
            let marker = postcss.comment({
              text: `marker:imported-file`,
              source: root.source,
            })

            fileMarkers.add(marker)
            root.prepend(marker)
          },
        },
      ],
    }),

    // Step 3: Analyze the AST so each stylesheet can have each import node
    // associated with it
    {
      postcssPlugin: 'import-thing2',
      Once() {
        // Associate import nodes with each stylesheet
        for (let fileMarker of fileMarkers) {
          let sourceFile = fileMarker.source?.input.file
          if (!sourceFile) continue

          let stylesheet = stylesheetsByFile.get(sourceFile)
          if (!stylesheet) continue

          // Find the closest import marker that precedes the file marker
          let node = fileMarker

          while (node) {
            if (importMarkers.has(node)) {
              break
            }

            let prev = node.prev()

            if (prev) {
              // Walk backwards until we find a node that is a marker
              node = prev
            } else if (node.parent) {
              // If there are no earlier siblings, go up a level and try again
              node = node.parent
            } else {
              break
            }
          }

          // We were unable to find an import marker
          // TODO: This should be an error
          if (node === fileMarker) continue

          // TODO: This shouldn't be possible
          if (!node.raws.original) continue

          stylesheet.importRules!.add(node.raws.original as AtRule)
        }

        // Analyze import nodes to determine layers
        for (let sheet of stylesheets) {
          for (let node of sheet.importRules ?? []) {
            let parts = segment(node.params, ' ')
            for (let part of parts) {
              if (!part.startsWith('layer(')) continue
              if (!part.endsWith(')')) continue

              let layers = segment(part.slice(6, -1), ',').map(name => name.trim())

              sheet.layers!.push(...layers)
            }
          }
        }

        // Connect all stylesheets together in a dependency graph
        // The way this works is it uses the knowledge that we have a list of
        // the `@import` nodes that cause a given stylesheet to be imported.
        // That import has a `source` pointing to parent stylesheet's file path
        // which can be used to look it up
        for (let sheet of stylesheets) {
          for (let node of sheet.importRules ?? []) {
            if (!node.source?.input.file) continue

            let sourceFile = node.source.input.file

            for (let parent of stylesheets) {
              if (parent.file !== sourceFile) continue
              sheet.parents!.add(parent)
            }
          }
        }
      },
    },

    // Step 4: Restore the AST to its original state
    {
      postcssPlugin: 'import-thing2',
      Once(root) {
        // Replace the dummy comment nodes with the original `@import` nodes
        for (let node of importMarkers) {
          node.replaceWith(node.raws.original)
        }

        // Remove all imported nodes
        root.walkAtRules('media', (rule) => {
          if (!rule.params.includes(mediaWrapper)) return
          rule.remove()
        })
      },
    },
  ])

  for (let sheet of stylesheets) {
    if (!sheet.file) continue
    if (!sheet.root) continue

    await processor.process(sheet.root, { from: sheet.file })
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
  let utilitySheets = new Map<Stylesheet, Stylesheet>()
  let newRules: postcss.AtRule[] = []

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

    let utilitySheet: Stylesheet = {
      file: sheet.file.replace(/\.css$/, '.utilities.css'),
      root: utilities,
    }

    utilitySheets.set(sheet, utilitySheet)

    // Add the import for the new utility file immediately following the old import
    for (let node of sheet.importRules ?? []) {
      newRules.push(node.cloneAfter({
        params: node.params.replace(/\.css(['"])/, '.utilities.css$1'),
      }))
    }
  }

  // The new import rules should have just the filename import
  // no layers, media queries, or anything else
  for (let node of newRules) {
    node.params = segment(node.params, ' ')[0]
  }

  for (let [originalSheet, utilitySheet] of utilitySheets) {
    utilitySheet.parents = new Set(Array.from(originalSheet.parents ?? []).map(parent => {
      return utilitySheets.get(parent) ?? parent
    }))
  }

  stylesheets.push(...utilitySheets.values())

  console.log(...stylesheets)
}

// @import './a.css' layer(utilities);
//  -> @import './b.css';
//    -> @import './c.css';
//       -> .utility-class
//       -> #main
//    -> other stuff
//  -> other stuff

// @import './a.css' layer(utilities);
//  -> @import './b.css';
//    -> @import './c.css';
//       -> #main
//    -> other stuff
// @import './a.utility.css';
//  -> @import './b.utility.css';
//    -> @import './c.utility.css';
//       -> @utility .utility-class
