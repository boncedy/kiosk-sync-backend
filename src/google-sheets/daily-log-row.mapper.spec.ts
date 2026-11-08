import {
  columnLetter,
  DAILY_LOG_SHEET_HEADERS,
  discrepancyPercent,
  formatSheetDateTime,
  mapDailyLogToRow,
  mapDailyLogsToRows,
  roundTo,
  SheetDailyLog,
  toSheetText,
} from './daily-log-row.mapper';

describe('DailyLog → Google Sheets row mapper (Story 03 – KES & Proof Image URL)', () => {
  const fullLog: SheetDailyLog = {
    id: 'b2c1f3a4-1111-4222-8333-944455556666',
    transactionId: 'TXN-20261031-001',
    kioskId: 'KIOSK-001',
    operatorId: 'OP-104',
    waterType: 'COMMERCIAL',
    meterVolume: 500,
    reportedCash: 950,
    expectedRevenue: 1000,
    variance: -50,
    isAnomaly: false,
    proofImageUrl: 'https://storage.namsa-ard.ke/proofs/txn-001.jpg',
    recordedAt: new Date('2026-10-31T10:00:00.000Z'),
    createdAt: new Date('2026-10-31T10:00:01.120Z'),
    checksum:
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  };

  const cell = (row: unknown[], header: string) =>
    row[DAILY_LOG_SHEET_HEADERS.indexOf(header)];

  describe('column layout', () => {
    it('has a stable, ordered header row with KES currency and Proof Image URL', () => {
      expect(DAILY_LOG_SHEET_HEADERS).toEqual([
        'Log ID',
        'Transaction ID',
        'Kiosk ID',
        'Operator ID',
        'Water Type',
        'Meter Volume (L)',
        'Reported Cash (KES)',
        'Expected Revenue (KES)',
        'Variance (KES)',
        'Discrepancy (%)',
        'Anomaly',
        'Recorded At',
        'Server Received At',
        'Checksum (SHA-256)',
        'Proof Image URL',
      ]);
    });

    it('produces exactly one cell per header', () => {
      expect(mapDailyLogToRow(fullLog)).toHaveLength(
        DAILY_LOG_SHEET_HEADERS.length,
      );
    });
  });

  describe('mapDailyLogToRow', () => {
    it('maps a full reconciled log into ordered, typed cells', () => {
      expect(mapDailyLogToRow(fullLog)).toEqual([
        'b2c1f3a4-1111-4222-8333-944455556666',
        'TXN-20261031-001',
        'KIOSK-001',
        'OP-104',
        'COMMERCIAL',
        500,
        950,
        1000,
        -50,
        -5,
        false,
        '2026-10-31 17:00:00',
        '2026-10-31 17:00:01',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'https://storage.namsa-ard.ke/proofs/txn-001.jpg',
      ]);
    });

    it('keeps numeric columns as numbers so sheet number formats apply', () => {
      const row = mapDailyLogToRow(fullLog);
      expect(typeof cell(row, 'Meter Volume (L)')).toBe('number');
      expect(typeof cell(row, 'Reported Cash (KES)')).toBe('number');
      expect(typeof cell(row, 'Variance (KES)')).toBe('number');
      expect(typeof cell(row, 'Anomaly')).toBe('boolean');
    });

    it('maps a minimal log (no optional fields) with empty cells, never "null"', () => {
      const row = mapDailyLogToRow({
        id: 'log-1',
        transactionId: 'TX-0001',
        kioskId: 'KIOSK-001',
        meterVolume: 12.5,
        checksum: null,
        recordedAt: '2026-10-18T09:00:00.000Z',
        createdAt: '2026-10-18T09:00:02.000Z',
      });

      expect(row).toEqual([
        'log-1',
        'TX-0001',
        'KIOSK-001',
        '',
        '',
        12.5,
        '',
        '',
        '',
        '',
        '',
        '2026-10-18 16:00:00',
        '2026-10-18 16:00:02',
        '',
        '',
      ]);
      expect(row).not.toContain(null);
      expect(row).not.toContain(undefined);
      expect(row).not.toContain('null');
    });

    it('accepts a full Prisma DailyLog shape (extra fields like isReadByManager are ignored)', () => {
      const prismaLog = {
        id: 'log-2',
        transactionId: 'TX-0002',
        kioskId: 'KIOSK-002',
        operatorId: 'OP-09',
        meterVolume: 100,
        reportedCash: 200,
        expectedRevenue: 200,
        variance: 0,
        isAnomaly: false,
        proofImageUrl: '/api/kiosk/evidence/TX-0002.jpg',
        checksum: 'abc',
        waterType: 'SUBSIDIZED' as const,
        isSynced: true,
        isReadByManager: false,
        recordedAt: new Date('2026-01-01T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      const row = mapDailyLogToRow(prismaLog);
      expect(row).toHaveLength(DAILY_LOG_SHEET_HEADERS.length);
      expect(cell(row, 'Water Type')).toBe('SUBSIDIZED');
      expect(cell(row, 'Proof Image URL')).toBe(
        '/api/kiosk/evidence/TX-0002.jpg',
      );
    });

    it('flags anomalies as boolean TRUE', () => {
      const row = mapDailyLogToRow({ ...fullLog, isAnomaly: true });
      expect(cell(row, 'Anomaly')).toBe(true);
    });

    it('rounds money to 2 decimals and volume to 3 decimals', () => {
      const row = mapDailyLogToRow({
        ...fullLog,
        meterVolume: 0.1 + 0.2 + 100.0004,
        reportedCash: 0.1 + 0.2,
        expectedRevenue: 1.005,
        variance: -0.30000000000000004,
      });
      expect(cell(row, 'Meter Volume (L)')).toBe(100.3);
      expect(cell(row, 'Reported Cash (KES)')).toBe(0.3);
      expect(cell(row, 'Expected Revenue (KES)')).toBe(1.01);
      expect(cell(row, 'Variance (KES)')).toBe(-0.3);
    });

    it('renders timestamps in the requested time zone', () => {
      const row = mapDailyLogToRow(fullLog, { timeZone: 'UTC' });
      expect(cell(row, 'Recorded At')).toBe('2026-10-31 10:00:00');
      expect(cell(row, 'Server Received At')).toBe('2026-10-31 10:00:01');
    });

    it('treats NaN / Infinity numbers as empty cells', () => {
      const row = mapDailyLogToRow({
        ...fullLog,
        reportedCash: Number.NaN,
        variance: Number.POSITIVE_INFINITY,
      });
      expect(cell(row, 'Reported Cash (KES)')).toBe('');
      expect(cell(row, 'Variance (KES)')).toBe('');
      expect(cell(row, 'Discrepancy (%)')).toBe('');
    });
  });

  describe('text cells (USER_ENTERED safety)', () => {
    it.each([
      ['=IMPORTXML("http://evil")', `'=IMPORTXML("http://evil")`],
      ['+1+1', `'+1+1`],
      ['-2+3', `'-2+3`],
      ['@SUM(A1)', `'@SUM(A1)`],
    ])('neutralises formula-like text %p', (input, expected) => {
      expect(toSheetText(input)).toBe(expected);
    });

    it.each([
      ['104', `'104`],
      ['00123', `'00123`],
      ['1e5', `'1e5`],
      ['12%', `'12%`],
      ['KES 200', `'KES 200`],
      ['2026-10-31', `'2026-10-31`],
      ['10/31', `'10/31`],
      ['TRUE', `'TRUE`],
    ])(
      'keeps number/date/boolean-looking text %p verbatim',
      (input, expected) => {
        expect(toSheetText(input)).toBe(expected);
      },
    );

    it.each(['KIOSK-001', 'OP-104', 'TXN-20261031-001', 'COMMERCIAL'])(
      'leaves ordinary identifier %p untouched',
      (input) => {
        expect(toSheetText(input)).toBe(input);
      },
    );

    it('keeps a numeric operator ID as text inside a row', () => {
      const row = mapDailyLogToRow({ ...fullLog, operatorId: '0042' });
      expect(cell(row, 'Operator ID')).toBe(`'0042`);
    });

    it('maps null / undefined / empty text to an empty cell', () => {
      expect(toSheetText(null)).toBe('');
      expect(toSheetText(undefined)).toBe('');
      expect(toSheetText('')).toBe('');
    });
  });

  describe('formatSheetDateTime', () => {
    it('formats Date and ISO strings as yyyy-MM-dd HH:mm:ss', () => {
      expect(
        formatSheetDateTime(
          new Date('2026-12-31T20:30:05.999Z'),
          'Asia/Bangkok',
        ),
      ).toBe('2027-01-01 03:30:05');
      expect(formatSheetDateTime('2026-02-03T04:05:06Z', 'UTC')).toBe(
        '2026-02-03 04:05:06',
      );
    });

    it('uses 00 (not 24) for midnight', () => {
      expect(formatSheetDateTime('2026-10-31T17:00:00Z', 'Asia/Bangkok')).toBe(
        '2026-11-01 00:00:00',
      );
    });

    it('returns an empty cell for invalid or missing dates', () => {
      expect(formatSheetDateTime('not-a-date', 'UTC')).toBe('');
      expect(formatSheetDateTime(null, 'UTC')).toBe('');
      expect(formatSheetDateTime(undefined, 'UTC')).toBe('');
    });
  });

  describe('discrepancyPercent', () => {
    it('computes variance ÷ expected revenue × 100', () => {
      expect(
        discrepancyPercent({
          ...fullLog,
          variance: -50,
          expectedRevenue: 1000,
        }),
      ).toBe(-5);
      expect(
        discrepancyPercent({ ...fullLog, variance: 10, expectedRevenue: 30 }),
      ).toBe(33.33);
    });

    it('is empty on zero or missing expected revenue', () => {
      expect(discrepancyPercent({ ...fullLog, expectedRevenue: 0 })).toBe('');
      expect(discrepancyPercent({ ...fullLog, expectedRevenue: null })).toBe(
        '',
      );
      expect(discrepancyPercent({ ...fullLog, variance: undefined })).toBe('');
    });
  });

  describe('helpers', () => {
    it('mapDailyLogsToRows keeps input order', () => {
      const rows = mapDailyLogsToRows([
        { ...fullLog, id: 'a' },
        { ...fullLog, id: 'b' },
      ]);
      expect(rows.map((r) => r[0])).toEqual(['a', 'b']);
    });

    it('roundTo avoids -0', () => {
      expect(Object.is(roundTo(-0.0001, 2), 0)).toBe(true);
    });

    it.each([
      [1, 'A'],
      [15, 'O'],
      [26, 'Z'],
      [27, 'AA'],
      [52, 'AZ'],
      [703, 'AAA'],
    ])('columnLetter(%i) = %s', (n, letter) => {
      expect(columnLetter(n)).toBe(letter);
    });

    it('columnLetter rejects invalid input', () => {
      expect(() => columnLetter(0)).toThrow(RangeError);
    });
  });
});
