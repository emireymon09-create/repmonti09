import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

// QA H5 (6 oct 2026): en "Registrar uno pasado" de /feeding, con Biberón
// elegido, el BottleBuilder y el campo "Sobró" (LeftoverField) eran HERMANOS
// con la misma `key={pPlanKey}`. React no puede distinguir dos hijos con la
// misma key: en el build de producción cada render dejaba un BottleBuilder
// huérfano en el DOM, y el LeftoverField, que se re-montaba y avisaba su valor
// con un objeto nuevo, disparaba el render siguiente. Medido en el navegador:
// 225 → 915 <select> en 3 s y el botón "Registrar" nunca quieto.
//
// No hay pruebas de componentes en este repo (CLAUDE.md §6), así que la red es
// estática: ningún elemento JSX del repo tiene dos hijos directos con la misma
// key escrita igual. Los hijos de un `.map()` viven en su propio arreglo y no
// cuentan; los de `{cond && <X key=…/>}` y de un ternario sí, porque React los
// reconcilia en el mismo arreglo que sus hermanos.

const ROOT = new URL('../../', import.meta.url).pathname
const DIRS = ['app', 'components']

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsxFiles(path))
    else if (name.endsWith('.tsx')) out.push(path)
  }
  return out
}

/** The JSX elements a child expression puts directly in its parent's array. */
function directElements(node: ts.Node): (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return [node]
  if (ts.isParenthesizedExpression(node)) return directElements(node.expression)
  if (ts.isJsxExpression(node)) return node.expression ? directElements(node.expression) : []
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return directElements(node.right)
  if (ts.isConditionalExpression(node))
    return [...directElements(node.whenTrue), ...directElements(node.whenFalse)]
  return []
}

function keyText(el: ts.JsxElement | ts.JsxSelfClosingElement, src: ts.SourceFile): string | null {
  const attrs = ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes
  for (const a of attrs.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText(src) === 'key' && a.initializer)
      return a.initializer.getText(src)
  }
  return null
}

function duplicateSiblingKeys(file: string): string[] {
  const src = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const seen = new Map<string, number>()
      for (const child of node.children) {
        // A ternary's two branches never render together: count each key once per child.
        const keys = new Set(
          directElements(child)
            .map((el) => keyText(el, src))
            .filter((k): k is string => k !== null),
        )
        for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1)
      }
      for (const [k, n] of seen) {
        if (n > 1) {
          const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
          found.push(`${relative(ROOT, file)}:${line} key=${k} ×${n}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return found
}

describe('JSX: no two siblings share a key', () => {
  it('in app/ and components/', () => {
    const files = DIRS.flatMap((d) => tsxFiles(join(ROOT, d)))
    expect(files.length).toBeGreaterThan(10)
    expect(files.flatMap(duplicateSiblingKeys)).toEqual([])
  })
})
