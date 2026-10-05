import { describe, expect, it, vi } from "vitest";

const execFileAsync = vi.fn(async (..._a: unknown[]) => ({ stdout: '{"dependencies":{}}', stderr: "" }));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/exec.js", async (orig) => {
	const real = await orig<typeof import("@blackbelt-technology/pi-dashboard-shared/platform/exec.js")>();
	return {
		...real,
		buildSafeArgv: (cmd: string, args: readonly string[]) => real.buildSafeArgv(cmd, args, "win32"),
		execFileAsync,
	};
});

describe("pi-core-checker default npm runner (Windows spawn)", () => {
	it("spawns npm via buildSafeArgv (cmd.exe), never a bare `npm` that ENOENTs on Windows", async () => {
		const { _internal } = await import("../pi/pi-core-checker.js");
		await expect(_internal.defaultNpmList()).resolves.toBe('{"dependencies":{}}');
		const [file, args, opts] = execFileAsync.mock.calls[0] as [string, string[], Record<string, unknown>];
		expect(file).toBe("cmd.exe");
		expect(args).toEqual(["/d", "/s", "/c", "npm", "list", "-g", "--depth=0", "--json"]);
		expect(opts).toMatchObject({ shell: false, windowsHide: true, timeout: 30_000 });
	});
});
