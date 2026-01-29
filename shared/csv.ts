export type CsvParseResult = {
  headers: string[];
  rows: Record<string, string>[];
};

const normalizeLine = (value: string) =>
  value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

export const parseCsv = (input: string): CsvParseResult => {
  const normalized = normalizeLine(input).trim();
  if (!normalized) {
    return { headers: [], rows: [] };
  }
  const lines = normalized.split("\n");
  const headers = parseCsvLine(lines[0] ?? "");
  const rows = lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
  return { headers, rows };
};

export const serializeCsv = (headers: string[], rows: Record<string, string>[]) => {
  const outputLines = [headers.map(escapeCsvValue).join(",")];
  rows.forEach((row) => {
    const line = headers.map((header) => escapeCsvValue(row[header] ?? "")).join(",");
    outputLines.push(line);
  });
  return outputLines.join("\n");
};

const parseCsvLine = (line: string) => {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
};

const escapeCsvValue = (value: string) => {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};
