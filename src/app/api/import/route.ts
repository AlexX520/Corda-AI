import ExcelJS from 'exceljs';
import { banker, currentUser, errorResponse, sameOrigin } from '@/lib/auth';
import { command } from '@/lib/service';
export async function POST(req: Request) {
  try {
    sameOrigin(req);
    const user = await currentUser();
    banker(user);
    const form = await req.formData(),
      file = form.get('file');
    if (!(file instanceof File) || file.size > 2_000_000)
      throw new Error('Choose a JSON or XLSX file smaller than 2 MB.');
    let rows: unknown[];
    if (file.name.endsWith('.json')) {
      rows = JSON.parse(await file.text());
      if (!Array.isArray(rows)) throw new Error('JSON must contain an array of email records.');
    } else if (file.name.endsWith('.xlsx')) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as never);
      const sheet = wb.worksheets[0];
      if (!sheet) throw new Error('Workbook is empty.');
      const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
      rows = [];
      sheet.eachRow((row, index) => {
        if (index === 1) return;
        const data: Record<string, unknown> = {};
        headers.forEach((h, j) => (data[h] = row.getCell(j + 1).text));
        data.to = String(data.to || 'banker@conferenceos.demo')
          .split(',')
          .map((s) => s.trim());
        data.cc = String(data.cc || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        rows.push(data);
      });
    } else throw new Error('Supported formats: .json and .xlsx.');
    if (rows.length > 100) throw new Error('Import at most 100 emails at a time.');
    const results = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        await command(user, 'ingest', rows[i]);
        results.push({ row: i + 1, ok: true });
      } catch (e) {
        results.push({
          row: i + 1,
          ok: false,
          error: e instanceof Error ? e.message : 'Import failed',
        });
      }
    }
    return Response.json({ results });
  } catch (e) {
    return errorResponse(e);
  }
}
