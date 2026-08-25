import { writeFileSync } from 'fs'

export function csvCell(value: string | number | boolean): string {
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function writeCsv(path: string, header: string[], rows: Array<Array<string | number | boolean>>): void {
  const lines = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n'
  writeFileSync(path, lines)
}
