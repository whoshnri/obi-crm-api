import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const dir = './src/generated'

function fixImports(filePath) {
  let content = readFileSync(filePath, 'utf8')
  const fixed = content.replace(
    /from ["'](\.(\/[^"']+)?)["']/g,
    (match, p1) => {
      if (p1.endsWith('.js') || p1.endsWith('.ts') || p1.endsWith('.json')) {
        return match
      }
      return match.replace(p1, p1 + '.js')
    }
  )
  if (fixed !== content) {
    writeFileSync(filePath, fixed)
    console.log('Fixed:', filePath)
  }
}

function walk(dir) {
  for (const file of readdirSync(dir)) {
    const full = join(dir, file)
    if (statSync(full).isDirectory()) walk(full)
    else if (file.endsWith('.ts') || file.endsWith('.js')) fixImports(full)
  }
}

walk(dir)
console.log('Done fixing Prisma imports.')