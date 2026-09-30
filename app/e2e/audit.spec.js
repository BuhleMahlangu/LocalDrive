// @ts-check
// Programmatic design + a11y audit. Measures what can actually be verified
// without eyeballing: contrast, touch targets, tap highlight, focusability,
// overflow and missing labels on the real rendered DOM.
import { test, expect } from '@playwright/test';

const OTP = '123456';
const DRIVER_PHONE = process.env.VITE_DRIVER_PHONE || '+27000000000';

const AUDIT = () => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  // Composite every ancestor layer, gradients included, so a button filled
  // with `linear-gradient(...)` is measured against the gradient it actually
  // renders rather than being treated as transparent.
  const gradientStops = (img) => {
    const out = [];
    for (const m of img.matchAll(/rgba?\([^)]+\)/g)) {
      const c = parse(m[0]);
      if (c) out.push(c);
    }
    return out;
  };
  const layerOf = (n) => {
    const s = getComputedStyle(n);
    const img = s.backgroundImage;
    if (img && img !== 'none' && /gradient/.test(img)) {
      const stops = gradientStops(img);
      // Fully transparent stops (gradient end points, "to transparent") carry no
      // colour and must not drag the average toward black.
      const solid = stops.filter((c) => c.a > 0.01);
      if (solid.length) {
        const sum = solid.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b, a: a.a + c.a }), {
          r: 0,
          g: 0,
          b: 0,
          a: 0,
        });
        const n = solid.length;
        return {
          r: sum.r / n,
          g: sum.g / n,
          b: sum.b / n,
          a: Math.min(1, sum.a / n),
        };
      }
    }
    const c = parse(s.backgroundColor);
    if (c && c.a > 0) return c;
    return null;
  };
  const bgOf = (el, { skipSelf = false } = {}) => {
    const stack = [];
    let n = skipSelf ? el.parentElement : el;
    while (n && n !== document.documentElement) {
      const l = layerOf(n);
      if (l) stack.push(l);
      n = n.parentElement;
    }
    // Fall back through the root chain to the first genuinely opaque colour.
    // A transparent root must not be composited as if it were black.
    let rootBg = null;
    for (const n of [document.documentElement, document.body, document.body.parentElement]) {
      const c = n && parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.99) {
        rootBg = c;
        break;
      }
    }
    stack.push(rootBg || { r: 255, g: 255, b: 255, a: 1 });
    let acc = stack[stack.length - 1];
    for (let i = stack.length - 2; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const out = { contrast: [], targets: [], nonInteractive: [], unlabelled: [], tiny: [], overflowX: 0 };

  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!own) continue;
    const px = parseFloat(s.fontSize);

    // Gradient-clipped text (`background-clip: text` + transparent fill) paints
    // the gradient itself, so `color` is meaningless. Measure the gradient's
    // lightest stop against the page background instead.
    const clipped =
      (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') &&
      (s.webkitTextFillColor === 'rgba(0, 0, 0, 0)' || s.color === 'rgba(0, 0, 0, 0)');

    let fg = clipped ? null : parse(s.color);
    if (clipped) {
      const stops = gradientStops(s.backgroundImage);
      if (stops.length) {
        // Lightest stop is the worst case for text on a light page.
        const lightest = stops.reduce((a, c) => (lum(c) > lum(a) ? c : a), stops[0]);
        fg = lightest;
      }
    }
    if (fg) {
      // Clipped text paints its own gradient, so that gradient is the
      // foreground and must not also count as the background behind it.
      const bg = bgOf(el, { skipSelf: clipped });
      const c = ratio(over(fg, bg), bg);
      const px = parseFloat(s.fontSize);
      const bold = +s.fontWeight >= 700;
      const large = px >= 24 || (px >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (c < need) {
        out.contrast.push({
          text: el.textContent.trim().slice(0, 42),
          cls: el.className.toString().slice(0, 46),
          ratio: +c.toFixed(2),
          need,
          px: +px.toFixed(1),
          fg: `${Math.round(fg.r)},${Math.round(fg.g)},${Math.round(fg.b)}`,
          bg: `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}`,
        });
      }
    }
    if (px < 11) out.tiny.push({ text: el.textContent.trim().slice(0, 32), px: +px.toFixed(1), cls: el.className.toString().slice(0, 40) });  }

  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, textarea')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // Resolve every ARIA labelling mechanism. aria-labelledby is equivalent to
    // aria-label, so a control labelled that way is not unlabelled.
    const labelledBy = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => (document.getElementById(id)?.textContent || '').trim())
      .join(' ')
      .trim();
    const label = (
      labelledBy ||
      el.getAttribute('aria-label') ||
      el.textContent ||
      el.value ||
      el.title ||
      ''
    ).trim();
    if (!label && el.tagName !== 'INPUT' && el.type !== 'checkbox') {
      out.unlabelled.push({ tag: el.tagName, cls: el.className.toString().slice(0, 46) });
    }
    if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A') {
      // An absolutely positioned ::after overlay is a legitimate way to grow
      // the tappable area past the painted box, so measure the real hit region
      // rather than flagging the visual size.
      const after = getComputedStyle(el, '::after');
      let hitH = r.height;
      let hitW = r.width;
      if (after.content !== 'none' && after.position === 'absolute') {
        const top = parseFloat(after.top);
        const bottom = parseFloat(after.bottom);
        const left = parseFloat(after.left);
        const right = parseFloat(after.right);
        if (!Number.isNaN(top) && !Number.isNaN(bottom)) hitH += r.height - (top + bottom);
        if (!Number.isNaN(left) && !Number.isNaN(right)) hitW += r.width - (left + right);
      }
      if (hitH < 32 || hitW < 32) {
        out.targets.push({
          text: label.slice(0, 26),
          cls: el.className.toString().slice(0, 40),
          w: Math.round(r.width),
          h: Math.round(r.height),
          hit: `${Math.round(hitW)}x${Math.round(hitH)}`,
        });
      }
    }
  }

  for (const el of document.querySelectorAll('[onclick]')) {
    const t = el.tagName;
    if (t === 'BUTTON' || t === 'A' || t === 'INPUT') continue;
    if (el.closest('button, a')) continue;
    if (visible(el)) {
      out.nonInteractive.push({ tag: t, cls: el.className.toString().slice(0, 46), text: el.textContent.trim().slice(0, 30) });
    }
  }

  out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  return out;
};

async function audit(page, label, theme) {
  const res = await page.evaluate(AUDIT);
  const lines = [`\n=== ${label} [${theme}] ===`];
  const worst = (a) => a.sort((x, y) => x.ratio - y.ratio);
  if (res.contrast.length) {
    lines.push(`-- contrast failures (${res.contrast.length}) --`);
    for (const c of worst(res.contrast).slice(0, 12)) {
      lines.push(`  ${c.ratio} < ${c.need}  ${c.px}px  "${c.text}"  .${c.cls}  fg(${c.fg}) bg(${c.bg})`);
    }
  }
  if (res.targets.length) {
    lines.push(`-- small tap targets (${res.targets.length}) --`);
    for (const t of res.targets.slice(0, 10)) lines.push(`  ${t.w}x${t.h}  "${t.text}"  .${t.cls}`);
  }
  if (res.nonInteractive.length) {
    lines.push(`-- click handlers on non-interactive elements (${res.nonInteractive.length}) --`);
    for (const n of res.nonInteractive.slice(0, 8)) lines.push(`  <${n.tag}> .${n.cls} "${n.text}"`);
  }
  if (res.unlabelled.length) {
    lines.push(`-- unlabelled controls (${res.unlabelled.length}) --`);
    for (const u of res.unlabelled.slice(0, 8)) lines.push(`  <${u.tag}> .${u.cls}`);
  }
  if (res.tiny.length) {
    lines.push(`-- text under 11px (${res.tiny.length}) --`);
    for (const t of res.tiny.slice(0, 8)) lines.push(`  ${t.px}px "${t.text}" .${t.cls}`);
  }
  lines.push(`-- horizontal overflow: ${res.overflowX}px`);
  console.log(lines.join('\n'));
}

async function login(page, { role, phone, name = 'Test User' }) {
  const isDriver = role === 'driver';
  await page.goto('/');
  await expect(page.locator('.landing-screen')).toBeVisible();
  await page.locator(isDriver ? '.landing-card .btn.driver.big' : '.landing-card .btn.primary.big').click();
  await expect(page.locator('.login-screen')).toBeVisible();
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator('form.card button.btn').click();
  await page.locator('input[inputmode="numeric"]').fill(OTP);
  await page.locator('input[placeholder="Thabo"]').fill(name);
  await page.locator('form.card button.btn').click();
}

test.describe.configure({ mode: 'serial' });

test('audit', async ({ browser }) => {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => {
      localStorage.setItem('drivelocal_onboarded', '1');
      localStorage.setItem('drivelocal_theme', t);
    }, theme);
    const page = await ctx.newPage();

    await page.goto('/');
    await expect(page.locator('.landing-screen')).toBeVisible();
    await page.waitForTimeout(600);
    await audit(page, 'landing', theme);

    await page.locator('.landing-card .btn.primary.big').click();
    await expect(page.locator('.login-screen')).toBeVisible();
    await audit(page, 'login', theme);
    await page.locator('form.card button.btn').click().catch(() => {});

    await login(page, { role: 'customer', phone: '+27731110000', name: 'Nomvula' });
    await expect(page.locator('.topbar')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1200);
    await audit(page, 'home', theme);

    await page.locator('.book-hero .btn.primary.big').click();
    await expect(page.locator('.leaflet-container')).toBeVisible();
    await page.waitForTimeout(800);
    await audit(page, 'book', theme);

    await page.locator('.nav-btn').nth(2).click();
    await page.waitForTimeout(800);
    await audit(page, 'history', theme);
    await ctx.close();
  }

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.grantPermissions(['geolocation'], { origin: 'http://localhost:5173' });
    await ctx.setGeolocation({ latitude: -26.2235, longitude: 29.2936, accuracy: 12 });
    await ctx.addInitScript((t) => localStorage.setItem('drivelocal_theme', t), theme);
    const page = await ctx.newPage();
    await login(page, { role: 'driver', phone: DRIVER_PHONE, name: 'Sipho' });
    await expect(page.locator('.dash-header')).toBeVisible({ timeout: 20_000 });
    const sw = page.locator('.switch input[type="checkbox"]');
    if (!(await sw.isChecked())) await page.locator('.switch .slider').click();
    await page.waitForTimeout(1500);
    await audit(page, 'dashboard', theme);

    for (const [i, name] of [[1, 'trips'], [2, 'insights'], [3, 'revenue'], [4, 'admin'], [5, 'profile']]) {
      const nav = page.locator('.bottom-nav .nav-btn');
      if ((await nav.count()) > i) {
        await nav.nth(i).click();
        await page.waitForTimeout(700);
        await audit(page, `driver/${name}`, theme);
      }
    }
    await ctx.close();
  }
});
