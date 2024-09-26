import fs from 'node:fs/promises'
import path from 'node:path'
import postcss from 'postcss'
import postcssImport from 'postcss-import'
import { formatNodes } from './codemods/format-nodes'
import { migrateAtApply } from './codemods/migrate-at-apply'
import { migrateAtLayerUtilities } from './codemods/migrate-at-layer-utilities'
import { migrateMissingLayers } from './codemods/migrate-missing-layers'
import { migrateTailwindDirectives } from './codemods/migrate-tailwind-directives'

export interface Stylesheet {
  file?: string

  content?: string | null
  root?: postcss.Root | null
  layers?: string[]
  media?: string[]
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
    .then((result) => result.css)
}

export async function migrate(stylesheet: Stylesheet) {
  if (!stylesheet.file) {
    throw new Error('Cannot migrate a stylesheet without a file path')
  }

  stylesheet.content = await migrateContents(stylesheet)
}

export async function analyze(stylesheets: Stylesheet[]) {
  let markers = new Set<postcss.Node>()
  let processor = postcss([
    postcssImport({
      plugins: [
        {
          postcssPlugin: 'import-marker',
          Once(root) {
            let marker = postcss.comment({
              text: 'tailwindcss-import-marker',
              source: root.source,
            })
            markers.add(marker)
            root.prepend(marker)
          },
        },
      ],
    }),
  ])

  console.log(
    'stylesheets',
    stylesheets.map((s) => s.file),
  )

  let stylesheetsByFile = new Map<string, Stylesheet>()
  for (let stylesheet of stylesheets) {
    if (!stylesheet.file) continue
    stylesheetsByFile.set(stylesheet.file, stylesheet)

    stylesheet.layers ??= []
    stylesheet.media ??= []
  }

  // Run stylesheets through `postcss-import` and record dependencies
  for (let stylesheet of stylesheets) {
    if (!stylesheet.file) continue
    if (!stylesheet.root) continue

    await processor.process(stylesheet.root.clone(), {
      from: stylesheet.file,
    })
  }

  // Walk up the graph from every marker to record potential layer metadata
  for (let marker of markers) {
    let sourceFile = marker.source?.input.file
    if (!sourceFile) continue

    let stylesheet = stylesheetsByFile.get(sourceFile)
    if (!stylesheet) continue

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
