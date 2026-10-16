// Email transport behind an injectable interface. 'stub' captures messages (tests/dev); on the
// box 'sendmail' pipes to the local Postfix queue. No credentials pass through the app for
// sendmail — Postfix owns delivery (DKIM/SPF). SMTP transport is a thin fallback.
import { spawn } from 'node:child_process';
import net from 'node:net';

export function makeMailer(config) {
  const from = config.mailFrom;
  const origin = config.publicOrigin || 'https://blockle.org';
  if (config.mailTransport === 'stub') {
    const sent = [];
    return {
      sent,
      async send({ to, subject, text }) { sent.push({ to, subject, text, from }); return { ok: true }; },
    };
  }
  if (config.mailTransport === 'sendmail') {
    return { async send(msg) { return sendViaSendmail(from, msg, origin); } };
  }
  return { async send(msg) { return sendViaSmtp(config, from, msg, origin); } };
}

function headerEncode(s) { return String(s).replace(/[\r\n]/g, ' '); } // never allow header injection
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Branded HTML part: Blockle logo header + the message, with any https link turned into a button.
function htmlBody(text, origin) {
  const url = (String(text).match(/https?:\/\/\S+/) || [])[0];
  const prose = esc(text).replace(/https?:\/\/\S+/g, '').trim().replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
  const button = url ? `<p style="text-align:center;margin:28px 0"><a href="${esc(url)}" style="background:#4d8bff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:600;display:inline-block">Continue</a></p><p style="color:#8a97ad;font-size:12px;word-break:break-all">Or paste this link: ${esc(url)}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#0b0e14;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0e14;padding:28px 0">
<tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#111622;border:1px solid #1e2838;border-radius:14px;padding:28px">
<tr><td align="center" style="padding-bottom:18px"><img src="${esc(origin)}/logo.png" alt="Blockle" width="48" height="48" style="border-radius:10px"></td></tr>
<tr><td style="color:#e6ecf5;font-size:15px;line-height:1.6"><p>${prose}</p>${button}</td></tr>
<tr><td style="padding-top:22px;border-top:1px solid #1e2838;color:#8a97ad;font-size:12px;line-height:1.5">
Blockle is self-custody — we will never ask for your seed phrase or backup passphrase. If you didn't request this, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
}

function buildMime(from, { to, subject, text }, origin) {
  const boundary = 'blk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return [
    `From: ${headerEncode(from)}`,
    `To: ${headerEncode(to)}`,
    `Subject: ${headerEncode(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '', String(text), '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '', htmlBody(text, origin), '',
    `--${boundary}--`, '',
  ].join('\r\n');
}

function sendViaSendmail(from, msg, origin) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/sbin/sendmail', ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ ok: true }) : reject(new Error(`sendmail ${code}: ${err}`))));
    p.stdin.end(buildMime(from, msg, origin));
  });
}

// Minimal ESMTP submit (plain, localhost). For local Postfix on 25; good enough as a fallback.
function sendViaSmtp(config, from, msg, origin) {
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
      else if (!dataSent) { dataSent = true; sock.write(buildMime(from, msg, origin) + '\r\n.\r\n'); }
      else { sock.write('QUIT\r\n'); sock.end(); resolve({ ok: true }); }
    });
  });
}
