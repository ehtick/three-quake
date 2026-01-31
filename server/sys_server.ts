// Server-side system interface for Deno
// Replaces browser sys.js for the dedicated server

export function Sys_Init(): void {
	console.log('Three-Quake Dedicated Server initializing...');
}

export function Sys_Error(error: string): never {
	console.error('Sys_Error:', error);
	Deno.exit(1);
}

export function Sys_Printf(fmt: string, ...args: unknown[]): void {
	if (args.length > 0) {
		// Simple printf-style formatting
		let result = fmt;
		for (const arg of args) {
			result = result.replace(/%[sdif]/, String(arg));
		}
		console.log(result);
	} else {
		console.log(fmt);
	}
}

export function Sys_Quit(): void {
	console.log('Sys_Quit');
	Deno.exit(0);
}

export function Sys_FloatTime(): number {
	return performance.now() / 1000.0;
}

export function Sys_DoubleTime(): number {
	return performance.now() / 1000.0;
}

// Server-specific: milliseconds for precise timing
export function Sys_Milliseconds(): number {
	return performance.now();
}
