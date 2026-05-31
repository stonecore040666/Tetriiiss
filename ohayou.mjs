import fs from 'fs';
import path from 'path';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'stonecore040666';
const REPO = 'Tetriiiss';
const BASE_DIR = '.';
const IGNORE = [
  'node_modules', 'dist', '.git', '.replit-artifact',
  '.replit', 'replit.nix', '.upm', '.cache', '.config',
  'upload_to_github.mjs', 'attached_assets', '.local', '.agents'
];

if (!TOKEN) { console.error('エラー: GITHUB_TOKEN未設定'); process.exit(1); }

console.log(`OWNER: ${OWNER}`);
console.log(`REPO: ${REPO}`);
console.log(`BASE_DIR: ${BASE_DIR}`);

const headers = { 'Authorization': `token ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'uploader' };

// トークンとリポジトリの確認
const check = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers });
if (check.status === 404) { console.error('エラー: リポジトリが見つかりません'); process.exit(1); }
if (check.status === 403) { console.error('エラー: トークンに権限がありません'); process.exit(1); }
console.log('リポジトリ確認OK\n');

async function upload(localPath, repoPath) {
  const content = fs.readFileSync(localPath).toString('base64');
  const shaRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${repoPath}`, { headers });
  const body = { message: `Add ${repoPath}`, content };
  if (shaRes.status === 200) body.sha = (await shaRes.json()).sha;
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${repoPath}`, { method: 'PUT', headers, body: JSON.stringify(body) });
  const ok = res.status === 200 || res.status === 201;
  if (!ok) {
    const err = await res.json();
    console.log(`✗ ${repoPath} (${res.status}: ${err.message})`);
  } else {
    console.log(`✓ ${repoPath}`);
  }
}

function getFiles(dir, base = '') {
  const files = [];
  for (const item of fs.readdirSync(dir)) {
    if (IGNORE.includes(item)) continue;
    const full = path.join(dir, item), rel = base ? `${base}/${item}` : item;
    if (fs.statSync(full).isDirectory()) files.push(...getFiles(full, rel));
    else files.push({ localPath: full, repoPath: rel });
  }
  return files;
}

const files = getFiles(BASE_DIR);
console.log(`${files.length}ファイルをアップロードします\n`);
for (const f of files) await upload(f.localPath, f.repoPath);
console.log('\n完了！');