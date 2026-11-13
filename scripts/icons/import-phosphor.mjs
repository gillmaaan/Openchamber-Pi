/**
 * Reads the Phosphor glyphs named in `phosphor-map.mjs` from a Phosphor
 * download and writes them as sprite markup to `phosphor-glyphs.mjs`.
 *
 * Usage: node scripts/icons/import-phosphor.mjs <Phosphor "SVGs" folder> [thin|light|regular|bold]
 *
 * The folder holds one subfolder per weight. The sprite markup goes into the
 * page as HTML, so every element and attribute is checked against a short
 * list and the import stops at anything else.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { phosphorMap } from "./phosphor-map.mjs"

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "phosphor-glyphs.mjs")
const [, , folder, weight = "regular"] = process.argv

const WEIGHTS = ["thin", "light", "regular", "bold"]
if (!folder || !WEIGHTS.includes(weight)) {
  console.error(`Usage: node scripts/icons/import-phosphor.mjs <Phosphor SVGs folder> [${WEIGHTS.join("|")}]`)
  process.exit(1)
}

// Phosphor draws on a 256 grid; the sprite symbols use 24.
const SCALE = 24 / 256

const NUMBER = /^-?\d+(?:\.\d+)?$/
const attributeRules = {
  d: /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/,
  points: /^[-\d.,\s]+$/,
  transform: /^(?:(?:rotate|translate|scale|matrix)\([-\d.,\s]+\)\s*)+$/,
  opacity: /^(?:0|1|0?\.\d+)$/,
  fill: /^(?:none|currentColor)$/,
  stroke: /^currentColor$/,
  "stroke-linecap": /^(?:round|butt|square)$/,
  "stroke-linejoin": /^(?:round|miter|bevel)$/,
  "stroke-miterlimit": NUMBER,
  "stroke-width": NUMBER,
}
for (const name of ["x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height"]) {
  attributeRules[name] = NUMBER
}
const ELEMENTS = new Set(["line", "rect", "path", "circle", "polyline", "polygon", "ellipse"])

const BACKGROUND = '<rect width="256" height="256" fill="none"/>'

const parseGlyph = (source, label) => {
  const wrapper = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256">([\s\S]*)<\/svg>\s*$/.exec(source)
  if (!wrapper) throw new Error(`${label}: unexpected SVG wrapper`)
  let inner = wrapper[1]
  if (!inner.startsWith(BACKGROUND)) throw new Error(`${label}: missing background rectangle`)
  inner = inner.slice(BACKGROUND.length)

  const elements = []
  let rest = inner
  const elementPattern = /^<([a-z]+)((?:\s+[a-z][a-z0-9-]*="[^"]*")*)\s*\/>/
  while (rest.length > 0) {
    const match = elementPattern.exec(rest)
    if (!match) throw new Error(`${label}: unsupported markup near "${rest.slice(0, 40)}"`)
    const [whole, tag, attributeText] = match
    if (!ELEMENTS.has(tag)) throw new Error(`${label}: element <${tag}> is not allowed`)
    const attributes = {}
    for (const [, name, value] of attributeText.matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/g)) {
      const rule = attributeRules[name]
      if (!rule || !rule.test(value)) throw new Error(`${label}: attribute ${name}="${value}" is not allowed`)
      attributes[name] = value
    }
    elements.push({ tag, attributes })
    rest = rest.slice(whole.length)
  }
  if (elements.length === 0) throw new Error(`${label}: no shapes`)
  return elements
}

const serialize = ({ tag, attributes }) => {
  const text = Object.entries(attributes).map(([name, value]) => ` ${name}="${value}"`).join("")
  return `<${tag}${text}/>`
}

const STROKE_KEYS = ["fill", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"]
// A circle has no ends or corners, so the regular weight leaves its cap, join and miter limit off or at their defaults.
const SMOOTH_KEYS = ["fill", "stroke", "stroke-width"]
const isSmooth = (element) => element.tag === "circle" || element.tag === "ellipse"
const keysOf = (element) => (isSmooth(element) ? SMOOTH_KEYS : STROKE_KEYS)
// A line has no inside, so the regular weight leaves its fill off.
const styleOf = (element, key) => (key === "fill" && element.tag === "line" ? element.attributes.fill ?? "none" : element.attributes[key])

const toSpriteMarkup = (elements, { flip, solid }, label) => {
  let groupAttributes
  let children
  const stroked = elements.filter((element) => element.attributes.stroke)
  // The solid weight and a glyph of nothing but dots draw filled shapes only.
  if (solid || stroked.length === 0) {
    if (stroked.length > 0 || elements.some((element) => element.attributes.fill)) {
      throw new Error(`${label}: a solid glyph carries a stroke or fill of its own`)
    }
    groupAttributes = ' fill="currentColor"'
    children = elements.map((element) => serialize(element))
  } else {
    if (stroked.some((element) => element.attributes["stroke-miterlimit"] && !isSmooth(element))) {
      throw new Error(`${label}: a miter limit on a shape with corners`)
    }
    const common = {}
    for (const key of STROKE_KEYS) {
      const values = new Set(stroked.filter((element) => keysOf(element).includes(key)).map((element) => styleOf(element, key)))
      if (values.size > 1) throw new Error(`${label}: shapes disagree on ${key}`)
      common[key] = [...values][0]
    }
    if (common.fill !== "none" || common.stroke !== "currentColor") throw new Error(`${label}: unexpected stroke style`)
    common["stroke-linecap"] ??= "round"
    common["stroke-linejoin"] ??= "round"
    groupAttributes = STROKE_KEYS.map((key) => ` ${key}="${common[key]}"`).join("")
    children = elements.map((element) => {
      if (element.attributes.stroke) {
        const attributes = { ...element.attributes }
        for (const key of [...STROKE_KEYS, "stroke-miterlimit"]) delete attributes[key]
        return serialize({ tag: element.tag, attributes })
      }
      // A solid dot among stroked shapes: it inherits the group's stroke style otherwise.
      return serialize({ tag: element.tag, attributes: { ...element.attributes, fill: "currentColor", stroke: "none" } })
    })
  }
  const body = `<g transform="scale(${SCALE})"${groupAttributes}>${children.join("")}</g>`
  return flip ? `<g transform="matrix(-1 0 0 1 24 0)">${body}</g>` : body
}

const fileFor = (icon, glyphWeight) => {
  const suffix = glyphWeight === "regular" ? "" : `-${glyphWeight}`
  return resolve(folder, glyphWeight, `${icon}${suffix}.svg`)
}

const glyphs = {}
const failures = []
for (const [name, entry] of Object.entries(phosphorMap).sort(([a], [b]) => a.localeCompare(b))) {
  const { icon, weight: entryWeight, flip = false } = typeof entry === "string" ? { icon: entry } : entry
  const glyphWeight = entryWeight ?? weight
  const label = `${name} -> ${icon} (${glyphWeight})`
  try {
    const source = readFileSync(fileFor(icon, glyphWeight), "utf8")
    glyphs[name] = toSpriteMarkup(parseGlyph(source, label), { flip, solid: glyphWeight === "fill" }, label)
  } catch (error) {
    failures.push(error.code === "ENOENT" ? `${label}: file not found` : error.message)
  }
}

if (failures.length > 0) {
  console.error(`${failures.length} glyph(s) could not be imported:\n  ${failures.join("\n  ")}`)
  process.exit(1)
}

const lines = Object.entries(glyphs).map(([name, markup]) => `  ${JSON.stringify(name)}: \`${markup}\`,`)
writeFileSync(outPath, `// Generated by scripts/icons/import-phosphor.mjs from the glyph names in phosphor-map.mjs. Do not edit by hand.
//
// Phosphor Icons, https://phosphoricons.com
// MIT License, Copyright (c) 2020-2024 Phosphor Icons
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

export const phosphorWeight = ${JSON.stringify(weight)}

export const phosphorGlyphs = {
${lines.join("\n")}
}
`)
console.log(`Imported ${Object.keys(glyphs).length} glyphs (${weight}) to ${outPath}`)
