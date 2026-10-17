import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
async function main() {
  const rows = JSON.parse(readFileSync('samples/emails.json', 'utf8'));
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Emails');
  sheet.columns = ['messageId', 'threadId', 'sender', 'to', 'cc', 'subject', 'body'].map((key) => ({
    header: key,
    key,
    width: key === 'body' ? 90 : 30,
  }));
  for (const r of rows) sheet.addRow({ ...r, to: r.to.join(', '), cc: r.cc.join(', ') });
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('body').alignment = { wrapText: true };
  await wb.xlsx.writeFile('samples/emails.xlsx');
}
void main();
