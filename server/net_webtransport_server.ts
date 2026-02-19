// WebTransport server driver for Deno
// Handles incoming client connections via WebTransport/HTTP3

import { Sys_Printf } from './sys_server.ts';
import { net_message } from '../src/net.js';

// Server configuration
let serverPort = 4433;
let certFile = 'cert.pem';
let keyFile = 'key.pem';

// DEPRECATED: These functions are no longer used with multi-process architecture
// Kept for backwards compatibility with game_server.js but they do nothing
export function WT_SetDirectMode(_enabled: boolean): void {}
export function WT_SetMapCallbacks(
	_changeMap: (mapName: string) => Promise<void>,
	_getCurrentMap: () => string
): void {}
export function WT_SetMaxClientsCallback(_setMaxClients: (maxClients: number) => void): void {}

// Connection tracking
// Transport protocol:
// - Reliable bidirectional stream for signon data, stringcmds, name/frag changes
// - Unreliable WebTransport datagrams for entity updates, clientdata, clc_move
interface ClientConnection {
	id: number;
	webTransport: WebTransport;
	reliableStream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null;
	reliableWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	reliableReader: ReadableStreamDefaultReader<Uint8Array> | null;
	datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	datagramReader: ReadableStreamDefaultReader<Uint8Array> | null;
	maxDatagramSize: number;
	pendingMessages: Array<{ reliable: boolean; data: Uint8Array }>;
	connected: boolean;
	address: string;
	lastMessageTime: number;
	pendingReliableWrites: number;
	pendingUnreliableWrites: number;
}

// Socket structure compatible with Quake's qsocket_t
export interface QSocket {
	next: QSocket | null;
	connecttime: number;
	lastMessageTime: number;
	lastSendTime: number;
	disconnected: boolean;
	canSend: boolean;
	sendNext: boolean;
	driver: number;
	landriver: number;
	socket: number;
	driverdata: ClientConnection | null;
	ackSequence: number;
	sendSequence: number;
	unreliableSendSequence: number;
	sendMessageLength: number;
	sendMessage: Uint8Array;
	receiveSequence: number;
	unreliableReceiveSequence: number;
	receiveMessageLength: number;
	receiveMessage: Uint8Array;
	addr: unknown;
	address: string;
}

// Active sockets
let activeSockets: QSocket | null = null;
let freeSockets: QSocket | null = null;
let numSockets = 0;

// Pending new connections
const pendingConnections: QSocket[] = [];

// QUIC endpoint and listener
let quicEndpoint: Deno.QuicEndpoint | null = null;

// Connection ID counter
let nextConnectionId = 1;

// Driver level (set by net_main)
let net_driverlevel = 0;

const NET_MAXMESSAGE = 8192;

// Maximum pending messages per connection before we consider it dead/flooding.
// The game loop consumes messages at 20Hz — if hundreds pile up, something is wrong.
const MAX_PENDING_MESSAGES = 100;

// Write backpressure limits.
// When writer.write() is called without await, each call queues a write promise.
// If the client's network is slow/congested, these pile up unbounded, causing:
// - Memory growth (each promise + Uint8Array frame stays alive until resolved)
// - QUIC stack CPU spike (processing the massive write queue)
// - Event loop starvation (same pattern as the datagram freeze from commit 82520e3)
const MAX_PENDING_WRITES_UNRELIABLE = 32;  // Expendable — skip and send fresh data next tick
const MAX_PENDING_WRITES_RELIABLE = 64;    // Critical — if this backed up, connection is dead

// Yield to the macrotask queue so setInterval (game loop) can run.
// reader.read() resolves via microtasks which can cascade without yielding.
// setTimeout(resolve, 0) ensures the game loop's setInterval gets a chance to fire.
function _yieldAfterRead(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

// Callback for socket allocation (injected from game_server.js)
// This allows using the shared socket pool from net_main.js
let _NET_NewQSocket: (() => QSocket | null) | null = null;
let _NET_FreeQSocket: ((sock: QSocket) => void) | null = null;

/**
 * Set the socket allocator callback
 */
export function WT_SetSocketAllocator(allocator: () => QSocket | null): void {
	_NET_NewQSocket = allocator;
}

/**
 * Set the socket freer callback
 */
export function WT_SetSocketFreer(freer: (sock: QSocket) => void): void {
	_NET_FreeQSocket = freer;
}

/**
 * Initialize the WebTransport server driver
 */
export function WT_Init(): number {
	Sys_Printf('WebTransport server driver initialized\n');
	return 0;
}

/**
 * Shutdown the WebTransport server driver
 */
export function WT_Shutdown(): void {
	Sys_Printf('WebTransport server driver shutting down\n');

	if (quicEndpoint) {
		quicEndpoint.close();
		quicEndpoint = null;
	}

	// Close all connections
	let sock = activeSockets;
	while (sock) {
		if (sock.driverdata) {
			try {
				sock.driverdata.webTransport.close();
			} catch {
				// Ignore errors during shutdown
			}
		}
		sock = sock.next;
	}
}

// Store cert/key for listen()
let serverCert = '';
let serverKey = '';

/**
 * Start or stop listening for connections
 */
export async function WT_Listen(state: boolean): Promise<void> {
	if (state) {
		if (quicEndpoint) return; // Already listening

		try {
			// Read TLS certificate and key
			serverCert = await Deno.readTextFile(certFile);
			serverKey = await Deno.readTextFile(keyFile);

			// Create QUIC endpoint
			quicEndpoint = new Deno.QuicEndpoint({
				hostname: '0.0.0.0',
				port: serverPort,
			});

			Sys_Printf('WebTransport server listening on port ' + serverPort + '\n');

			// Start accepting connections in background
			_acceptConnections();
		} catch (error) {
			Sys_Printf(
				'Failed to start WebTransport listener: ' +
					(error as Error).message +
					'\n'
			);
		}
	} else {
		if (quicEndpoint) {
			quicEndpoint.close();
			quicEndpoint = null;
			Sys_Printf('WebTransport server stopped listening\n');
		}
	}
}

/**
 * Background task to accept incoming connections
 */
async function _acceptConnections(): Promise<void> {
	if (!quicEndpoint) return;

	try {
		// Get listener from endpoint with TLS options
		const listener = quicEndpoint.listen({
			cert: serverCert,
			key: serverKey,
			alpnProtocols: ['h3'], // HTTP/3 for WebTransport
		});

		// Accept connections using listener.accept() which returns QuicConn directly
		while (quicEndpoint) {
			try {
				// Use listener.accept() to get QuicConn directly
				const conn = await listener.accept();

				const remoteAddr = conn.remoteAddr;
				const address = remoteAddr.hostname + ':' + remoteAddr.port;
				Sys_Printf('Connection from ' + address + '\n');

				// Handle in background
				(async () => {
					try {
						// Upgrade to WebTransport
						// @ts-ignore - unstable API
						const wt: WebTransport = await Deno.upgradeWebTransport(conn);
						await _handleWebTransportSession(wt, address);
					} catch (error) {
						Sys_Printf('Connection error: ' + (error as Error).message + '\n');
						try { conn.close(); } catch { /* ignore */ }
					}
				})();
			} catch (error) {
				if (quicEndpoint) {
					Sys_Printf('Accept error: ' + (error as Error).message + '\n');
					// Delay before retrying to prevent 100% CPU spin if accept() fails repeatedly
					await new Promise(resolve => setTimeout(resolve, 100));
				}
			}
		}
	} catch (error) {
		if (quicEndpoint) {
			Sys_Printf(
				'Listener error: ' + (error as Error).message + '\n'
			);
		}
	}
}

/**
 * Handle an already-upgraded WebTransport session
 */
async function _handleWebTransportSession(wt: WebTransport, address: string): Promise<void> {
	try {
		await wt.ready;

		// Register wt.closed handler early — before stream acceptance.
		// If stream acceptance times out or fails, wt.closed can reject without
		// a catch handler, causing unhandled rejection crashes in logs.
		// We store the sock/conn references later once they exist.
		let earlyDeath = false;
		let deferredSock: QSocket | null = null;
		let deferredConn: ClientConnection | null = null;
		wt.closed.then(() => {
			if (deferredSock !== null && deferredConn !== null) {
				_handleConnectionDeath(deferredSock, deferredConn);
			} else {
				earlyDeath = true;
			}
		}).catch(() => {
			if (deferredSock !== null && deferredConn !== null) {
				_handleConnectionDeath(deferredSock, deferredConn);
			} else {
				earlyDeath = true;
			}
		});

		const clientConn: ClientConnection = {
			id: nextConnectionId++,
			webTransport: wt,
			reliableStream: null,
			reliableWriter: null,
			reliableReader: null,
			datagramWriter: null,
			datagramReader: null,
			maxDatagramSize: 0,
			pendingMessages: [],
			connected: true,
			address: address,
			lastMessageTime: Date.now(),
			pendingReliableWrites: 0,
			pendingUnreliableWrites: 0,
		};

		// Accept the first bidirectional stream (reliable channel)
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		const { value: stream, done } = await streamReader.read();

		if (done || !stream) {
			streamReader.releaseLock();
			wt.close();
			return;
		}
		clientConn.reliableStream = stream;
		clientConn.reliableWriter = stream.writable.getWriter();
		clientConn.reliableReader = stream.readable.getReader();

		streamReader.releaseLock();

		// Unreliable channel via WebTransport datagrams
		const datagrams = wt.datagrams;
		if (!datagrams) {
			Sys_Printf('Client %s has no datagram support, closing\n', address);
			wt.close();
			return;
		}
		clientConn.datagramWriter = datagrams.writable.getWriter();
		clientConn.datagramReader = datagrams.readable.getReader();
		const maxDatagramSize = datagrams.maxDatagramSize;
		if (typeof maxDatagramSize === 'number') {
			clientConn.maxDatagramSize = maxDatagramSize;
		}

		// Create a socket for this game connection
		// Note: With multi-process architecture, lobby protocol is handled by lobby_server.js
		// Game servers (this code) always run in direct mode
		const sock = _newQSocket();
		if (!sock) {
			Sys_Printf('No free sockets for %s\n', address);
			wt.close();
			return;
		}

		sock.address = clientConn.address;
		sock.driverdata = clientConn;
		sock.connecttime = performance.now() / 1000;
		sock.lastMessageTime = performance.now() / 1000;

		pendingConnections.push(sock);

		// Wire up deferred wt.closed handler (registered early, before stream acceptance)
		deferredSock = sock;
		deferredConn = clientConn;

		// If the transport died during stream acceptance, handle it now
		if (earlyDeath) {
			_handleConnectionDeath(sock, clientConn);
			return;
		}

		_startBackgroundReaders(sock, clientConn);

	} catch (error) {
		Sys_Printf('Session error for %s: %s\n', address, (error as Error).message);
		try { wt.close(); } catch { /* ignore */ }
	}
}

/**
 * Start background readers for reliable stream + unreliable datagrams.
 */
function _startBackgroundReaders(
	sock: QSocket,
	conn: ClientConnection
): void {
	// Read reliable messages from the first bidirectional stream
	(async () => {
		try {
			while (conn.connected && conn.reliableReader) {
				const data = await _readFramedMessage(conn.reliableReader);
				if (data === null) break;

				conn.pendingMessages.push({ reliable: true, data });
				conn.lastMessageTime = Date.now();

				// If messages are piling up, the game loop isn't consuming them
				if (conn.pendingMessages.length > MAX_PENDING_MESSAGES) {
					Sys_Printf('Reliable reader: %d pending messages for %s, disconnecting\n', conn.pendingMessages.length, conn.address);
					conn.connected = false;
					break;
				}

				// Yield to macrotask queue after reading so the game loop can run
				await _yieldAfterRead();
			}
		} catch (error) {
			if (conn.connected) {
				Sys_Printf('Reliable reader error for %s: %s\n', conn.address, String(error));
				conn.connected = false;
			}
		}
		// Release the reader lock when done
		try {
			conn.reliableReader?.releaseLock();
		} catch { /* ignore */ }
	})();

	// Read unreliable messages from datagrams
	(async () => {
		try {
			while (conn.connected && conn.datagramReader) {
				const { value, done } = await conn.datagramReader.read();
				if (done) break;
				if (value === undefined || value.length === 0) continue;

				conn.pendingMessages.push({ reliable: false, data: new Uint8Array(value) });
				conn.lastMessageTime = Date.now();

				// If messages are piling up, the game loop isn't consuming them
				if (conn.pendingMessages.length > MAX_PENDING_MESSAGES) {
					Sys_Printf('Unreliable reader: %d pending messages for %s, disconnecting\n', conn.pendingMessages.length, conn.address);
					conn.connected = false;
					break;
				}

				// Yield to macrotask queue after reading so the game loop can run
				await _yieldAfterRead();
			}
		} catch (error) {
			if (conn.connected) {
				Sys_Printf('Datagram reader error for %s: %s\n', conn.address, String(error));
				conn.connected = false;
			}
		}
		// Release the reader lock when done
		try {
			conn.datagramReader?.releaseLock();
		} catch { /* ignore */ }
	})();
}

/**
 * Read a framed message from the stream
 * Frame format: [length:2][data:N]
 * Returns: Uint8Array or null on error/EOF
 */
const _emptyMessage = new Uint8Array(0);
async function _readFramedMessage(
	reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<Uint8Array | null> {
	// Read header (2 bytes)
	const header = await _readExact(reader, 2);
	if (header === null) {
		return null;
	}

	const length = header[0] | (header[1] << 8);

	if (length === 0) {
		return _emptyMessage;
	}

	// Read message data
	return await _readExact(reader, length);
}

// Buffer for leftover bytes from previous reads (per-reader tracking)
const _readerBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, { data: Uint8Array | null; offset: number }>();

function _getReaderBuffer(reader: ReadableStreamDefaultReader<Uint8Array>): { data: Uint8Array | null; offset: number } {
	let buf = _readerBuffers.get(reader);
	if (!buf) {
		buf = { data: null, offset: 0 };
		_readerBuffers.set(reader, buf);
	}
	return buf;
}

/**
 * Read exactly n bytes from a reader, with buffering for leftover bytes.
 * Always copies data into a new Uint8Array to avoid holding references to
 * QUIC stream internal buffers (which can cause buffer starvation and
 * event loop freezes in Deno's QUIC stack).
 */
async function _readExact(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	n: number
): Promise<Uint8Array | null> {
	const buf = _getReaderBuffer(reader);
	const result = new Uint8Array(n);
	let offset = 0;

	// Drain leftover bytes from previous read
	if (buf.data !== null) {
		const available = buf.data.length - buf.offset;
		const bytesToCopy = Math.min(available, n);
		result.set(buf.data.subarray(buf.offset, buf.offset + bytesToCopy), 0);
		offset = bytesToCopy;
		buf.offset += bytesToCopy;

		if (buf.offset >= buf.data.length) {
			buf.data = null;
			buf.offset = 0;
		}
	}

	// Read from stream until we have n bytes
	while (offset < n) {
		const { value, done } = await reader.read();
		if (done) return null;
		if (value === undefined || value.length === 0) return null;

		const bytesToCopy = Math.min(value.length, n - offset);
		result.set(value.subarray(0, bytesToCopy), offset);
		offset += bytesToCopy;

		// Save leftover bytes for next call
		if (bytesToCopy < value.length) {
			buf.data = value;
			buf.offset = bytesToCopy;
		}
	}

	return result;
}

/**
 * Create a new socket
 * Uses the injected allocator from net_main.js if available (preferred)
 * Otherwise falls back to internal allocation
 */
function _newQSocket(): QSocket | null {
	// If we have an external allocator (from net_main.js), use it
	if (_NET_NewQSocket !== null) {
		const sock = _NET_NewQSocket();
		if (sock !== null) {
			sock.driver = net_driverlevel;
		}
		return sock;
	}

	// Fallback to internal allocation (for standalone testing)
	if (!freeSockets) {
		// Allocate more sockets if needed
		if (numSockets >= 32) return null; // Max sockets

		const sock: QSocket = {
			next: null,
			connecttime: 0,
			lastMessageTime: 0,
			lastSendTime: 0,
			disconnected: false,
			canSend: true,
			sendNext: false,
			driver: net_driverlevel,
			landriver: 0,
			socket: 0,
			driverdata: null,
			ackSequence: 0,
			sendSequence: 0,
			unreliableSendSequence: 0,
			sendMessageLength: 0,
			sendMessage: new Uint8Array(NET_MAXMESSAGE),
			receiveSequence: 0,
			unreliableReceiveSequence: 0,
			receiveMessageLength: 0,
			receiveMessage: new Uint8Array(NET_MAXMESSAGE),
			addr: null,
			address: '',
		};

		numSockets++;
		return sock;
	}

	const sock = freeSockets;
	freeSockets = sock.next;

	// Reset socket state
	sock.next = activeSockets;
	activeSockets = sock;
	sock.disconnected = false;
	sock.canSend = true;
	sock.driverdata = null;

	return sock;
}

/**
 * Handle connection death (WebTransport closed or errored)
 *
 * Per original Quake design (net_main.c):
 * - sock.disconnected is ONLY set by NET_FreeQSocket (after freeing)
 * - We should NOT set it here for sockets assigned to clients
 * - Just set conn.connected = false, which makes WT_QGetMessage return -1
 * - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
 *
 * Exception: sockets still in pendingConnections were never assigned to a client,
 * so we must clean them up directly (including setting disconnected and freeing).
 */
function _handleConnectionDeath(sock: QSocket, conn: ClientConnection): void {
	conn.connected = false;

	// Cancel readers to unblock any stuck reader.read() calls in _readExact.
	// Without this, reader loops can spin indefinitely after the transport closes.
	try {
		if (conn.reliableReader) {
			conn.reliableReader.cancel().catch(() => {});
		}
		if (conn.datagramReader) {
			conn.datagramReader.cancel().catch(() => {});
		}
	} catch { /* ignore */ }

	// Check if socket is still in pending queue (never assigned to a client)
	const pendingIdx = pendingConnections.indexOf(sock);
	if (pendingIdx !== -1) {
		// Socket never made it to a client slot - clean up directly
		pendingConnections.splice(pendingIdx, 1);
		sock.disconnected = true;  // Only set for pending sockets

		// Free the socket back to the pool (only for pending sockets)
		if (_NET_FreeQSocket !== null) {
			_NET_FreeQSocket(sock);
		}
	}
	// For sockets already assigned to clients:
	// - DON'T set sock.disconnected = true (would skip NET_Close cleanup)
	// - conn.connected = false makes WT_QGetMessage return -1
	// - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
}

/**
 * Free a socket
 */
export function WT_FreeQSocket(sock: QSocket): void {
	// Remove from active list
	if (sock === activeSockets) {
		activeSockets = sock.next;
	} else {
		let s = activeSockets;
		while (s) {
			if (s.next === sock) {
				s.next = sock.next;
				break;
			}
			s = s.next;
		}
	}

	// Add to free list
	sock.next = freeSockets;
	freeSockets = sock;
	sock.disconnected = true;
}

/**
 * Search for hosts (server doesn't search)
 */
export function WT_SearchForHosts(_xmit: boolean): void {
	// Server doesn't search for other servers
}

/**
 * Connect (server doesn't connect out)
 */
export function WT_Connect(_host: string): null {
	// Server doesn't connect to other servers
	return null;
}

/**
 * Check for new incoming connections
 */
export function WT_CheckNewConnections(): QSocket | null {
	// Filter out any disconnected sockets first
	while (pendingConnections.length > 0) {
		const sock = pendingConnections[0];
		if (sock.disconnected) {
			// Socket died before we could process it, remove and continue
			pendingConnections.shift();
			Sys_Printf('Skipped disconnected socket in pending queue\n');
			continue;
		}
		return pendingConnections.shift()!;
	}
	return null;
}

/**
 * Get a message from a socket
 */
export function WT_QGetMessage(sock: QSocket): number {
	const conn = sock.driverdata;
	if (conn === null) return -1;

	if (!conn.connected && conn.pendingMessages.length === 0) {
		return -1;
	}

	if (conn.pendingMessages.length === 0) {
		return 0;
	}

	// Get next message
	let msg = conn.pendingMessages.shift()!;

	// For unreliable messages, skip to the most recent one.
	// In original Quake, unreliable messages are overwritten by newer ones.
	// The WebTransport datagram reader queues all datagrams, so if the client
	// sends faster than the server reads, stale messages pile up.
	// Discard stale unreliable messages but preserve any reliable messages.
	if (!msg.reliable) {
		while (conn.pendingMessages.length > 0) {
			const next = conn.pendingMessages[0];
			if (next.reliable) break; // Stop at next reliable message
			conn.pendingMessages.shift();
			msg = next; // Use newer unreliable message
		}
	}

	// Copy to net_message
	net_message.cursize = 0;
	for (let i = 0; i < msg.data.length && i < net_message.maxsize; i++) {
		net_message.data[i] = msg.data[i];
		net_message.cursize++;
	}

	sock.lastMessageTime = performance.now() / 1000;

	return msg.reliable ? 1 : 2;
}

/**
 * Send a reliable message.
 */
export function WT_QSendMessage(
	sock: QSocket,
	data: { data: Uint8Array; cursize: number }
): number {
	const conn = sock.driverdata;
	if (!conn || !conn.connected || !conn.reliableWriter) {
		return -1;
	}

	// Backpressure: if too many writes are in-flight, the connection is dead/zombie
	if (conn.pendingReliableWrites >= MAX_PENDING_WRITES_RELIABLE) {
		Sys_Printf('WT_QSendMessage: %d reliable pending writes for %s, disconnecting\n', conn.pendingReliableWrites, conn.address);
		conn.connected = false;
		return -1;
	}

	// Frame the message: [length:2][data:N]
	const frame = new Uint8Array(2 + data.cursize);
	frame[0] = data.cursize & 0xff;
	frame[1] = (data.cursize >> 8) & 0xff;
	frame.set(data.data.subarray(0, data.cursize), 2);

	conn.pendingReliableWrites++;
	conn.reliableWriter.write(frame).then(() => {
		conn.pendingReliableWrites--;
	}).catch((err) => {
		conn.pendingReliableWrites--;
		Sys_Printf('WT_QSendMessage: write FAILED: %s\n', (err as Error).message);
		conn.connected = false;
	});

	return 1;
}

/**
 * Send an unreliable message over WebTransport datagrams.
 */
export function WT_SendUnreliableMessage(
	sock: QSocket,
	data: { data: Uint8Array; cursize: number }
): number {
	const conn = sock.driverdata;
	if (!conn || !conn.connected || !conn.datagramWriter) return -1;

	// Backpressure: unreliable messages are expendable — skip if writes are backed up.
	// Next tick will send fresh data anyway.
	if (conn.pendingUnreliableWrites >= MAX_PENDING_WRITES_UNRELIABLE) {
		return 1; // Pretend success — caller doesn't need to know we dropped it
	}

	if (conn.maxDatagramSize > 0 && data.cursize > conn.maxDatagramSize) {
		return 1;
	}

	const packet = new Uint8Array(data.cursize);
	packet.set(data.data.subarray(0, data.cursize), 0);

	conn.pendingUnreliableWrites++;
	conn.datagramWriter.write(packet).then(() => {
		conn.pendingUnreliableWrites--;
	}).catch(() => {
		conn.pendingUnreliableWrites--;
		// Unreliable — silently fail
	});

	return 1;
}

/**
 * Check if we can send a reliable message
 */
export function WT_CanSendMessage(sock: QSocket): boolean {
	const conn = sock.driverdata;
	return conn !== null
		&& conn.connected
		&& conn.reliableWriter !== null
		&& conn.pendingReliableWrites < MAX_PENDING_WRITES_RELIABLE;
}

/**
 * Check if we can send an unreliable message
 */
export function WT_CanSendUnreliableMessage(sock: QSocket): boolean {
	const conn = sock.driverdata;
	return conn !== null
		&& conn.connected
		&& conn.datagramWriter !== null
		&& conn.pendingUnreliableWrites < MAX_PENDING_WRITES_UNRELIABLE;
}

/**
 * Close a connection
 */
export function WT_Close(sock: QSocket): void {
	const conn = sock.driverdata;
	if (!conn) return;

	conn.connected = false;

	try {
		// Cancel readers first — unblocks any stuck reader.read() in _readExact
		if (conn.reliableReader) {
			conn.reliableReader.cancel().catch(() => {});
			conn.reliableReader = null;
		}
		if (conn.datagramReader) {
			conn.datagramReader.cancel().catch(() => {});
			conn.datagramReader = null;
		}

		// Close writers
		if (conn.reliableWriter) {
			conn.reliableWriter.close().catch(() => {});
			conn.reliableWriter = null;
		}
		if (conn.datagramWriter) {
			conn.datagramWriter.releaseLock();
			conn.datagramWriter = null;
		}
		conn.webTransport.close();
	} catch {
		// Ignore errors during close
	}

	Sys_Printf('Connection closed: ' + conn.address + '\n');
	sock.driverdata = null;
}

/**
 * Configure the server
 */
export function WT_SetConfig(config: {
	port?: number;
	certFile?: string;
	keyFile?: string;
}): void {
	if (config.port) serverPort = config.port;
	if (config.certFile) certFile = config.certFile;
	if (config.keyFile) keyFile = config.keyFile;
}

/**
 * Set driver level (called by net_main)
 */
export function WT_SetDriverLevel(level: number): void {
	net_driverlevel = level;
}

/**
 * Get the maximum pendingWrites count across all active connections.
 * Used for heartbeat diagnostics to detect write backpressure building up.
 */
export function WT_GetMaxPendingWrites(): number {
	let max = 0;
	let sock = activeSockets;
	while (sock) {
		const conn = sock.driverdata;
		if (conn !== null) {
			const pendingTotal = conn.pendingReliableWrites + conn.pendingUnreliableWrites;
			if (pendingTotal > max) {
				max = pendingTotal;
			}
		}
		sock = sock.next;
	}
	// Also check pending connections
	for (let i = 0; i < pendingConnections.length; i++) {
		const conn = pendingConnections[i].driverdata;
		if (conn !== null) {
			const pendingTotal = conn.pendingReliableWrites + conn.pendingUnreliableWrites;
			if (pendingTotal > max) {
				max = pendingTotal;
			}
		}
	}
	return max;
}

/**
 * Export socket type for external use
 */
export type { QSocket as qsocket_t };
