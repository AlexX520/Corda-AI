import { createHash } from 'node:crypto';
import MsgReader, { type FieldsData } from '@kenjiuno/msgreader';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export type ImportedEmail = {
  messageId: string;
  threadId: string;
  sender: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
};

const digest = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);

function addresses(value?: AddressObject | AddressObject[]) {
  const objects = !value ? [] : Array.isArray(value) ? value : [value];
  return objects
    .flatMap((item) => item.value)
    .flatMap((item) => (item.group?.length ? item.group : [item]))
    .map((item) => item.address?.trim().toLowerCase())
    .filter((item): item is string => Boolean(item && item.includes('@')));
}

function threadId(mail: ParsedMail, subject: string, fallback: string) {
  const references = Array.isArray(mail.references) ? mail.references[0] : mail.references;
  const header = mail.headers.get('thread-index');
  const key =
    (typeof header === 'string' && header) ||
    references ||
    mail.inReplyTo ||
    subject.replace(/^\s*(re|fw|fwd):\s*/gi, '').trim().toLowerCase() ||
    fallback;
  return `outlook-thread-${digest(String(key))}`;
}

function cleanHtml(value: string) {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fromEml(bytes: Uint8Array): Promise<ImportedEmail> {
  const mail = await simpleParser(Buffer.from(bytes));
  const fallback = digest(bytes);
  const subject = mail.subject?.trim() || 'Imported Outlook email';
  const sender = addresses(mail.from)[0] || '';
  const body = mail.text?.trim() || (typeof mail.html === 'string' ? cleanHtml(mail.html) : '');
  return {
    messageId: mail.messageId?.slice(0, 200) || `outlook-${fallback}`,
    threadId: threadId(mail, subject, fallback),
    sender,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject,
    body,
  };
}

function recipientEmails(recipients: FieldsData[] | undefined, type: 'to' | 'cc') {
  return (recipients || [])
    .filter((recipient) => recipient.recipType === type)
    .map((recipient) => recipient.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email && email.includes('@')));
}

async function fromMsg(bytes: Uint8Array): Promise<ImportedEmail> {
  const msgBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let data: FieldsData;
  try {
    data = new MsgReader(msgBuffer).getFileData();
  } catch {
    throw new Error('Outlook could not read this MSG file. It may be damaged or use an unsupported format.');
  }
  if (data.error) throw new Error(`Outlook could not read this MSG file: ${data.error}`);
  const fallback = digest(bytes);
  const headerMail = data.headers
    ? await simpleParser(`${data.headers}\r\n${data.body || ''}`)
    : undefined;
  const subject = data.subject?.trim() || headerMail?.subject?.trim() || 'Imported Outlook email';
  const sender =
    (data.senderEmail?.includes('@') ? data.senderEmail.trim().toLowerCase() : '') ||
    addresses(headerMail?.from)[0] ||
    '';
  const body =
    data.body?.trim() ||
    (data.bodyHtml ? cleanHtml(data.bodyHtml) : '') ||
    headerMail?.text?.trim() ||
    '';
  const topic = data.conversationTopic || subject.replace(/^\s*(re|fw|fwd):\s*/gi, '');
  return {
    messageId: data.messageId?.slice(0, 200) || headerMail?.messageId?.slice(0, 200) || `outlook-${fallback}`,
    threadId: threadId(headerMail || ({ headers: new Map() } as ParsedMail), topic, fallback),
    sender,
    to: recipientEmails(data.recipients, 'to').concat(addresses(headerMail?.to)),
    cc: recipientEmails(data.recipients, 'cc').concat(addresses(headerMail?.cc)),
    subject,
    body,
  };
}

export async function parseEmailFile(fileName: string, bytes: Uint8Array) {
  const extension = fileName.toLowerCase().split('.').pop();
  const email = extension === 'eml' ? await fromEml(bytes) : extension === 'msg' ? await fromMsg(bytes) : null;
  if (!email) throw new Error('Supported Outlook formats: .eml and .msg.');
  if (!email.sender) throw new Error('No SMTP sender address was found in this Outlook file.');
  if (!email.body) throw new Error('No readable email body was found in this Outlook file.');
  email.to = [...new Set(email.to)];
  email.cc = [...new Set(email.cc)];
  return email;
}
