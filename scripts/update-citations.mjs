// Fetches the Google Scholar profile and updates the citation count in
// content/publications.md. Only the digits inside "cited **N** times" are
// touched; every other part of the file is left byte-for-byte identical.
//
// Behavior:
//  - Uses SerpAPI when SERPAPI_KEY is set (reliable), otherwise scrapes the
//    profile page directly (may be blocked by Google from datacenter IPs).
//  - On success with a new number: rewrites the file and sets output
//    "changed=true" so the workflow commits the update.
//  - On success with the same number: no change, exit 0.
//  - On fetch/parse failure: emits a warning annotation and exits 0 without
//    touching anything, so a blocked run never breaks or alters the site.

import { readFile, writeFile } from 'node:fs/promises';

const SCHOLAR_USER = process.env.SCHOLAR_USER || '5VqeNC4AAAAJ';
const FILE = 'content/publications.md';
const TARGET = /cited \*\*\d+\*\* times/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return await res.text();
      console.log(`attempt ${i}: HTTP ${res.status}`);
    } catch (e) {
      console.log(`attempt ${i}: ${e.message}`);
    }
    if (i < attempts) await sleep(15000);
  }
  throw new Error('all fetch attempts failed');
}

async function citationsFromSerpApi(key) {
  const json = await fetchWithRetry(
    `https://serpapi.com/search.json?engine=google_scholar_author&author_id=${SCHOLAR_USER}&hl=en&api_key=${key}`
  );
  const data = JSON.parse(json);
  const n = data?.author_profile?.table_citation?.citations?.[0]?.citations;
  if (!n) throw new Error('citations field not found in SerpAPI response');
  return String(n).replace(/,/g, '');
}

async function citationsFromScholar() {
  const html = await fetchWithRetry(
    `https://scholar.google.com/citations?hl=en&user=${SCHOLAR_USER}`
  );
  if (html.includes('CAPTCHA') || html.includes('not a robot')) {
    throw new Error('blocked by CAPTCHA');
  }
  const m = html.match(/Citations<\/a><\/td>\s*<td class="gsc_rsb_std">([\d,]+)</);
  if (!m) throw new Error('citation pattern not found in profile page');
  return m[1].replace(/,/g, '');
}

try {
  const source = process.env.SERPAPI_KEY ? 'serpapi' : 'direct';
  const citations = process.env.SERPAPI_KEY
    ? await citationsFromSerpApi(process.env.SERPAPI_KEY)
    : await citationsFromScholar();
  console.log(`source=${source} citations=${citations}`);

  const md = await readFile(FILE, 'utf8');
  if (!TARGET.test(md)) throw new Error('"cited **N** times" not found in publications.md');
  const current = (md.match(/\*\*(\d+)\*\* times/) || [])[1];
  if (current === citations) {
    console.log(`unchanged (${citations}); nothing to do`);
  } else {
    await writeFile(FILE, md.replace(TARGET, `cited **${citations}** times`));
    console.log(`updated ${current} -> ${citations}`);
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(process.env.GITHUB_OUTPUT, 'changed=true\n');
    }
  }
} catch (e) {
  console.warn(`::warning::Citation update skipped: ${e.message}. The site is left unchanged.`);
}
