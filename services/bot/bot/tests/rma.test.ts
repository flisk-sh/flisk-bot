import { expect, test } from "bun:test";
import { tuneBoardPage, withHeader } from "../src/rma";
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
