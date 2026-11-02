// Сбор покрытия JS через Chrome DevTools Protocol (так же, как вкладка Coverage в DevTools).
const fs = require('fs');
const path = require('path');

const merged = new Map(); // исходник скрипта -> Uint8Array (1 = символ выполнялся)

async function start(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Debugger.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  return cdp;
}

async function stop(cdp) {
  const { result } = await cdp.send('Profiler.takePreciseCoverage');
  for (const s of result) {
    if (!s.url.startsWith('http://shop.test')) continue;
    let scriptSource;
    try {
      ({ scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: s.scriptId }));
    } catch { continue; } // скрипт уже выгружен (страница перезагружалась)
    if (!scriptSource.includes('const GAMES')) continue; // нужен только inline-скрипт магазина

    const hit = new Uint8Array(scriptSource.length);
    const ranges = s.functions.flatMap(f => f.ranges);
    // внешние диапазоны раньше вложенных: вложенные переопределяют родителя
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) hit.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);

    if (!merged.has(scriptSource)) merged.set(scriptSource, new Uint8Array(scriptSource.length));
    const acc = merged.get(scriptSource);
    for (let i = 0; i < hit.length; i++) if (hit[i]) acc[i] = 1;
  }
  await cdp.detach().catch(() => {});
}

function report(html, outDir) {
  const lines = [];
  for (const [src, acc] of merged) {
    const lineOffset = html.slice(0, html.indexOf(src)).split('\n').length - 1;
    let total = 0, covered = 0, full = 0, codeLines = 0;
    const missed = [];
    let pos = 0;
    src.split('\n').forEach((text, idx) => {
      let t = 0, c = 0;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        t++; if (acc[pos + i]) c++;
      }
      pos += text.length + 1;
      const trimmed = text.trim();
      if (!t || trimmed.startsWith('//')) return;
      codeLines++; total += t; covered += c;
      if (c === t) full++;
      else missed.push(`строка ${idx + lineOffset + 1} (${Math.round(100 * c / t)}%): ${trimmed.slice(0, 90)}`);
    });
    lines.push('# Покрытие кода (index.html, inline-скрипт)', '',
      `- Символов кода выполнено: ${covered}/${total} = **${(100 * covered / total).toFixed(1)}%**`,
      `- Строк выполнено полностью: ${full}/${codeLines} = **${(100 * full / codeLines).toFixed(1)}%**`, '');
    if (missed.length) lines.push('## Строки, выполненные не полностью', '', ...missed.map(m => `- ${m}`), '');
    else lines.push('Все строки выполнены полностью.', '');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const text = lines.join('\n');
  fs.writeFileSync(path.join(outDir, 'code-coverage.md'), text);
  return text;
}

module.exports = { start, stop, report };
