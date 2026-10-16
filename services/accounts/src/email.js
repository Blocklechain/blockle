// Email transport behind an injectable interface. 'stub' captures messages (tests/dev); on the
// box 'sendmail' pipes to the local Postfix queue. No credentials pass through the app for
// sendmail — Postfix owns delivery (DKIM/SPF). SMTP transport is a thin fallback.
import { spawn } from 'node:child_process';
import net from 'node:net';

export function makeMailer(config) {
  const from = config.mailFrom;
  if (config.mailTransport === 'stub') {
    const sent = [];
    return {
      sent,
      async send({ to, subject, text }) { sent.push({ to, subject, text, from }); return { ok: true }; },
    };
  }
  if (config.mailTransport === 'sendmail') {
    return { async send(msg) { return sendViaSendmail(from, msg); } };
  }
  return { async send(msg) { return sendViaSmtp(config, from, msg); } };
}

function headerEncode(s) { return String(s).replace(/[\r\n]/g, ' '); } // never allow header injection

function buildMime(from, { to, subject, text }) {
  return [
    `From: ${headerEncode(from)}`,
    `To: ${headerEncode(to)}`,
    `Subject: ${headerEncode(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '', String(text),
  ].join('\r\n');
}

function sendViaSendmail(from, msg) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/sbin/sendmail', ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ ok: true }) : reject(new Error(`sendmail ${code}: ${err}`))));
    p.stdin.end(buildMime(from, msg));
  });
}

// Minimal ESMTP submit (plain, localhost). For local Postfix on 25; good enough as a fallback.
function sendViaSmtp(config, from, msg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(config.smtpPort, config.smtpHost);
    const fromAddr = (from.match(/<([^>]+)>/) || [null, from])[1];
    const steps = [
      `EHLO blockle.org`, `MAIL FROM:<${fromAddr}>`, `RCPT TO:<${msg.to}>`, 'DATA',
    ];
    let stage = -1, dataSent = false;
    sock.setTimeout(10000, () => { sock.destroy(); reject(new Error('smtp timeout')); });
    sock.on('error', reject);
    sock.on('data', (buf) => {
      const line = buf.toString();
      const code = +line.slice(0, 3);
      if (code >= 400) { sock.destroy(); return reject(new Error(`smtp ${line.trim()}`)); }
      if (stage < steps.length - 1) { stage++; sock.write(steps[stage] + '\r\n'); }
      else if (!dataSent) { dataSent = true; sock.write(buildMime(from, msg) + '\r\n.\r\n'); }
      else { sock.write('QUIT\r\n'); sock.end(); resolve({ ok: true }); }
    });
  });
}
