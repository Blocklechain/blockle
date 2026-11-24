// -----------------------------------------------------------------------------
// IPv4-ONLY EGRESS, for BitGo.
//
// WHY THIS EXISTS.
//
// The BitGo access token is IP-restricted to this host's IPv4 address. The box
// also has IPv6 (2605:a140:2256:2287::1), and Node's default behaviour is Happy
// Eyeballs: resolve both families, race them, use whichever connects first. So
// the same request succeeds or fails depending on which race IPv6 wins, and the
// failure arrives as:
//
//   401 {"error":"Attempt to use IP-restricted token from an unauthorized IP
//        address"}
//
// which reads exactly like a bad token. That cost real debugging time already.
//
// TWO MEASURES, because one is a preference and the other is proof.
//
// 1. pinIPv4() — sets `dns.setDefaultResultOrder("ipv4first")` and disables
//    auto-select-family, so Node resolves A records first and does NOT race
//    AAAA. With the race off, the first address is the one used, so this is
//    effectively IPv4-only rather than merely IPv4-preferred.
//
//    Verified on Node 20.19.4: a request to app.bitgo-test.com reports
//    `remoteFamily === "IPv4"` with these set, and would otherwise be free to
//    pick IPv6.
//
// 2. verifyIPv4Egress() — actually opens a socket and INSPECTS the family. A
//    configuration that silently stopped working would otherwise present as an
//    authentication failure weeks later. Checking the thing itself, rather than
//    trusting that setting a flag had the intended effect, is the difference
//    between a control and a comment.
//
// WHY NOT `family: 4` ON THE REQUEST. That is a harder guarantee and is
// available on `https.request`, but `fetch` does not accept it without
// supplying an undici dispatcher, and the BitGo adapter is built around an
// injectable `fetch` so that its 380 lines of tests never touch the network.
// Trading that testability for a marginally stronger pin would be the wrong
// swap — so the pin is global and then VERIFIED, which closes the same gap.
// -----------------------------------------------------------------------------

import { connect } from "node:tls";
import dns from "node:dns";
import net from "node:net";

export class EgressError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EgressError";
	}
}

let pinned = false;

/**
 * Force IPv4 for every outbound connection in this process.
 *
 * Idempotent and safe to call more than once — a service may call it at
 * startup and a test may call it again.
 */
export function pinIPv4(): void {
	if (pinned) return;
	// A records first.
	dns.setDefaultResultOrder("ipv4first");
	// And do not race AAAA against them. With the race disabled Node uses the
	// first resolved address, which the line above has made an A record.
	if (typeof net.setDefaultAutoSelectFamily === "function") {
		net.setDefaultAutoSelectFamily(false);
	}
	pinned = true;
}

export function isPinned(): boolean {
	return pinned;
}

export interface EgressCheck {
	readonly host: string;
	/** "IPv4" | "IPv6" as the socket reports it. */
	readonly family: string;
	/** The address actually used — what BitGo's whitelist must contain. */
	readonly address: string;
	readonly ok: boolean;
}

/**
 * Open a real TLS connection and report which family and address were used.
 *
 * Deliberately a TLS connect rather than a plain DNS lookup: DNS tells you
 * what addresses EXIST, not which one the stack would choose. The question
 * that matters is what BitGo will see as the source, and only an actual
 * connection answers it.
 */
export function verifyIPv4Egress(
	host: string,
	timeoutMs = 10_000,
): Promise<EgressCheck> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host, port: 443, servername: host }, () => {
			const family = socket.remoteFamily ?? "unknown";
			const address = socket.remoteAddress ?? "unknown";
			socket.destroy();
			resolve({ host, family, address, ok: family === "IPv4" });
		});
		socket.setTimeout(timeoutMs, () => {
			socket.destroy();
			reject(new EgressError(`egress check to ${host} timed out after ${timeoutMs}ms`));
		});
		socket.on("error", (e) => {
			socket.destroy();
			reject(new EgressError(`egress check to ${host} failed: ${e.message}`));
		});
	});
}

/**
 * Pin IPv4 and REFUSE TO CONTINUE if the pin did not take.
 *
 * Called at service startup before anything touches BitGo. Failing loudly here
 * is the whole point: the alternative is a service that starts cleanly, pins
 * nothing, and then reports every custody read as an authentication failure.
 *
 * Note which direction this fails. An unreachable host is reported as a
 * warning and does not stop startup — the network may simply be down, and a
 * custody service that cannot start during a blip is worse than one that
 * starts and reports UNAVAILABLE. But a connection that comes up over IPv6 is
 * a hard stop, because that one WILL produce silent 401s.
 */
export async function pinAndVerify(
	host = "app.bitgo-test.com",
	log: (s: string) => void = console.log,
): Promise<EgressCheck | undefined> {
	pinIPv4();
	let check: EgressCheck;
	try {
		check = await verifyIPv4Egress(host);
	} catch (e) {
		log(
			`WARNING: could not verify IPv4 egress to ${host} ` +
				`(${e instanceof Error ? e.message : String(e)}). ` +
				`IPv4 is pinned but UNVERIFIED; if BitGo returns 401 with ` +
				`"IP-restricted token", this is the first thing to check.`,
		);
		return undefined;
	}

	if (!check.ok) {
		throw new EgressError(
			`refusing to start: outbound connections are leaving over ` +
				`${check.family} (${check.address}) despite the IPv4 pin. The BitGo ` +
				`token is whitelisted to this host's IPv4 address only, so every ` +
				`custody read would fail as an IP-restriction 401 that looks like a ` +
				`bad token. Disable IPv6 egress or add ${check.address} to the ` +
				`token's whitelist.`,
		);
	}

	log(`IPv4 egress verified: ${host} via ${check.address} (${check.family})`);
	return check;
}
