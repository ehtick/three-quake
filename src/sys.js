// Ported from: WinQuake/sys.h + sys_win.c -- system interface (browser)

/*
===============================================================================

SYSTEM IO

===============================================================================
*/

export function Sys_Init() {

	console.log( 'Three-Quake initializing...' );

}

export function Sys_Error( error ) {

	console.error( 'Sys_Error: ' + error );

	// Display error on screen (browser only)
	if ( typeof document !== 'undefined' ) {

		document.body.innerHTML = '<pre style="color:red;padding:20px;font-size:16px;">Sys_Error: ' + error + '</pre>';

	}

	throw new Error( error );

}

export function Sys_Printf( fmt, ...args ) {

	console.log( fmt, ...args );

}

export function Sys_Quit() {

	console.log( 'Sys_Quit' );

}

export function Sys_FloatTime() {

	return performance.now() / 1000.0;

}

export function Sys_DoubleTime() {

	return performance.now() / 1000.0;

}
