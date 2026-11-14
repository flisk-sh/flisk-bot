import { expect, test } from "bun:test";
import { KEYBOARD_FIT, tuneBoardPage, withHeader } from "../src/rma";
import { PAGE } from "../src/rma.generated";

test("tuneBoardPage disables kLoad periodic polling on the bot board", () => {
	const tuned = tuneBoardPage(PAGE);
	expect(tuned).not.toContain("setInterval(kLoad,3000);kLoad();");
	expect(tuned).toContain("/* kLoad disabled on bot board */");
});

test("tuneBoardPage slows sessions polling to 15s and gates on visibility", () => {
	const tuned = tuneBoardPage(PAGE);
	expect(tuned).not.toContain("load();setInterval(load,3000);");
	expect(tuned).toContain(
		"setInterval(()=>{if(!document.hidden)load()},15000)",
	);
	expect(tuned).toContain(
		'document.addEventListener("visibilitychange",()=>{if(!document.hidden)load()})',
	);
});

test("withHeader returns tuned board page with header bar", () => {
	const res = withHeader(PAGE, "https://jobs.flisk.si");
	expect(res).toContain('id="flhead"');
	expect(res).not.toContain("setInterval(kLoad,3000);kLoad();");
	expect(res).not.toContain("load();setInterval(load,3000);");
	expect(res).toContain("setInterval(()=>{if(!document.hidden)load()},15000)");
});

test("withHeader keeps the header from pushing a phone page sideways", () => {
	const res = withHeader(PAGE, "https://jobs.flisk.si");
	expect(res).toContain("#flhead a{white-space:nowrap;flex:none}");
	expect(res).toMatch(/@media\(max-width:640px\)\{#flhead\{[^}]*overflow-x:auto/);
});

test("withHeader keeps text fields at 16px on touch screens so iPhone Safari does not zoom", () => {
	const res = withHeader(PAGE, "https://jobs.flisk.si");
	expect(res).toContain("@media (pointer:coarse){input:not([type=checkbox])");
	expect(res).toContain("textarea,select{font-size:16px!important}");
});

// Runs the keyboard fit against a fake iPhone: 844px tall page, keyboard leaves 553px visible.
function runFit(src: string, { height = 553, scale = 1 } = {}) {
  const listeners: Record<string, () => void> = {};
  const classes = new Set<string>();
  const body = { style: {} as Record<string, string> };
  const vv = { height: 844, scale: 1, offsetTop: 0, addEventListener: (e: string, f: () => void) => { listeners[e] = f; } };
  const document = { body, documentElement: { clientHeight: 844, classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } } };
  new Function('window', 'document', src)({ visualViewport: vv }, document);
  Object.assign(vv, { height, scale, offsetTop: 40 });
  listeners.resize();
  return { body, classes };
}

test('keyboard open on an iPhone: the body is pinned to the visible part of the screen', () => {
  const { body, classes } = runFit(KEYBOARD_FIT);
  expect(classes.has('kbopen')).toBe(true);
  expect(body.style).toEqual({ position: 'fixed', top: '40px', left: '0', right: '0', height: '553px' });
});

test('pinch zoom is not mistaken for the keyboard', () => {
  const { body, classes } = runFit(KEYBOARD_FIT, { height: 400, scale: 2 });
  expect(classes.has('kbopen')).toBe(false);
  expect(body.style.position).toBe('');
});

test("withHeader adds the keyboard fit and hides the header and side panel while typing on a phone", () => {
  const page = withHeader(PAGE, "");
  expect(page).toContain(`<script>${KEYBOARD_FIT}</script></body>`);
  expect(page).toContain("html.kbopen .side{display:none!important}");
});
