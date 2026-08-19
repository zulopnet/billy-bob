// tools/deploy.mjs — copy the build into the saas-website public tree.
//
//   npm run deploy      (runs `vite build` first)
//
// Deploying this game takes THREE steps and skipping the second or third is a
// silent failure, not a 404:
//
//   1. `npm run deploy` here            — build + copy into public/games/
//   2. `npx vite build` in saas-website — public/ is only copied at ITS build
//   3. the slug must be in GAME_SLUGS in saas-website/server/server.js,
//      then `systemctl --user restart zulopai-backend`
//
// Step 3 is the trap. `express.static` runs with `index: false`, so a slug
// missing from GAME_SLUGS does not 404 — it falls through to the SPA catch-all
// and serves the React homepage with **HTTP 200**. Cache purging cannot fix it,
// and `curl` reports success either way. Verify with a real browser.
//
// This script checks all three and tells you which one is outstanding.

import { cp, rm, readFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SLUG = 'billy-bob'
const HERE = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SITE = resolve(HERE, '../saas-website')
const DIST = join(HERE, 'dist')
const TARGET = join(SITE, 'public/games', SLUG)

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await exists(join(DIST, 'index.html')))) {
    console.error(`no build at ${DIST} — run \`npx vite build\` first`)
    process.exit(1)
  }
  if (!(await exists(SITE))) {
    console.error(`saas-website not found at ${SITE}`)
    process.exit(1)
  }

  await rm(TARGET, { recursive: true, force: true })
  await cp(DIST, TARGET, { recursive: true })
  console.log(`✓ copied dist/ → ${TARGET}`)

  // --- check step 3 -------------------------------------------------------
  const serverPath = join(SITE, 'server/server.js')
  let registered = false
  try {
    const src = await readFile(serverPath, 'utf8')
    const m = src.match(/const GAME_SLUGS = \[([^\]]*)\]/)
    registered = !!m && m[1].includes(`'${SLUG}'`)
  } catch {
    console.warn(`! could not read ${serverPath}`)
  }

  console.log('')
  if (registered) {
    console.log(`✓ '${SLUG}' is in GAME_SLUGS`)
  } else {
    console.log(`✗ '${SLUG}' is NOT in GAME_SLUGS in server/server.js`)
    console.log('  Without it the URL serves the React homepage with HTTP 200,')
    console.log('  which looks like a caching problem and is not one.')
  }
  console.log('')
  console.log('Still to do:')
  console.log(`  cd ${SITE} && npx vite build`)
  if (!registered) console.log(`  …and add '${SLUG}' to GAME_SLUGS in server/server.js`)
  console.log('  systemctl --user restart zulopai-backend')
  console.log('')
  console.log(`Then verify in a real browser (not curl): https://zulop.net/games/${SLUG}/`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
