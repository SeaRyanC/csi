import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

// Types
interface Transaction {
  date: string;
  merchant: string;
  category: string;
  account: string;
  originalStatement: string;
  notes: string;
  amount: number;
  tags: string;
  owner: string;
  fixedCategory: string;
}

interface PivotData {
  [category: string]: {
    [month: number]: number;
  };
}

interface CellSelection {
  category: string;
  month: number;
  year: number;
}

interface ColumnMapping {
  date: number;
  merchant: number;
  category: number;
  account: number;
  originalStatement: number;
  notes: number;
  amount: number;
  tags: number;
  owner: number;
  fixedCategory: number;
}

type SortColumn = 'date' | 'merchant' | 'category' | 'account' | 'originalStatement' | 'notes' | 'tags' | 'owner' | 'amount';
type SortDirection = 'asc' | 'desc';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORAGE_KEY = 'csi-tsv-data';

// Column synonyms in priority order (first match wins)
const COLUMN_SYNONYMS: { [key: string]: string[] } = {
  date: ['date', 'transaction date', 'trans date', 'posted date', 'posting date', 'trans_date', 'txn date', 'txn_date'],
  merchant: ['merchant', 'vendor', 'payee', 'description', 'merchant name', 'name', 'store'],
  category: ['category', 'type', 'expense type', 'transaction type', 'trans type', 'spending category'],
  account: ['account', 'account name', 'card', 'payment method', 'source', 'bank', 'credit card'],
  originalStatement: ['original statement', 'statement', 'memo', 'original description', 'raw description', 'bank description'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'remark'],
  amount: ['amount', 'total', 'sum', 'value', 'price', 'cost', 'transaction amount', 'trans amount'],
  tags: ['tags', 'tag', 'labels', 'label'],
  owner: ['owner', 'user', 'person', 'member', 'paid by', 'purchaser'],
  fixedCategory: ['fixedcategory', 'fixed category', 'override category', 'corrected category', 'manual category'],
};

// Detect column indices from headers
function detectColumnMapping(headers: string[]): ColumnMapping {
  const normalizedHeaders = headers.map(h => h.toLowerCase().trim());
  const mapping: Partial<ColumnMapping> = {};
  const usedIndices = new Set<number>();

  // For each field, find the best matching column
  for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
    // First check for "Fixed" prefix override
    if (field !== 'fixedCategory') {
      const fixedSynonyms = synonyms.map(s => `fixed${s}`).concat(synonyms.map(s => `fixed ${s}`));
      for (const synonym of fixedSynonyms) {
        const idx = normalizedHeaders.findIndex((h, i) => !usedIndices.has(i) && h === synonym);
        if (idx !== -1) {
          // This is the fixed version - store as fixedX field
          const fixedField = `fixed${field.charAt(0).toUpperCase() + field.slice(1)}` as keyof ColumnMapping;
          if (!(fixedField in mapping)) {
            mapping[fixedField] = idx;
            usedIndices.add(idx);
          }
        }
      }
    }

    // Now look for the regular field
    for (const synonym of synonyms) {
      const idx = normalizedHeaders.findIndex((h, i) => !usedIndices.has(i) && h === synonym);
      if (idx !== -1) {
        mapping[field as keyof ColumnMapping] = idx;
        usedIndices.add(idx);
        break;
      }
    }
  }

  // Return mapping with -1 for missing fields
  return {
    date: mapping.date ?? -1,
    merchant: mapping.merchant ?? -1,
    category: mapping.category ?? -1,
    account: mapping.account ?? -1,
    originalStatement: mapping.originalStatement ?? -1,
    notes: mapping.notes ?? -1,
    amount: mapping.amount ?? -1,
    tags: mapping.tags ?? -1,
    owner: mapping.owner ?? -1,
    fixedCategory: mapping.fixedCategory ?? -1,
  };
}

// Parse a date string in various formats to extract year and month
// Note: For ambiguous dates like '12/11/2025', MM/DD/YYYY is preferred (US convention)
// European DD/MM/YYYY is only used when the first number > 12 (unambiguously a day)
function parseDateString(dateStr: string): { year: number; month: number; day: number } | null {
  const trimmed = dateStr.trim();
  
  // Try YYYY-MM-DD or YYYY/MM/DD (ISO format)
  let match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return {
      year: parseInt(match[1]!, 10),
      month: parseInt(match[2]!, 10),
      day: parseInt(match[3]!, 10),
    };
  }

  // Try MM-DD-YYYY, MM/DD/YYYY, DD-MM-YYYY, or DD/MM/YYYY
  // We prefer MM/DD/YYYY interpretation, but if first number > 12 and second <= 12, swap (European)
  match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    let first = parseInt(match[1]!, 10);
    let second = parseInt(match[2]!, 10);
    const year = parseInt(match[3]!, 10);
    
    // If first > 12 and second <= 12, assume European DD/MM/YYYY format
    if (first > 12 && second <= 12) {
      return { year, month: second, day: first };
    }
    // Otherwise assume MM/DD/YYYY (or MM/DD/YYYY for ambiguous cases)
    return { year, month: first, day: second };
  }

  return null;
}

// Detect sign convention: returns true if negative numbers should be inverted to positive (expenses)
// If equal counts or empty, returns false (no inversion) - amounts are kept as-is
function detectSignConvention(amounts: number[]): boolean {
  const negativeCount = amounts.filter(a => a < 0).length;
  const positiveCount = amounts.filter(a => a > 0).length;
  // If more negative than positive, assume negative = expense, so invert
  return negativeCount > positiveCount;
}

// Generate synthetic data for pre-population
function generateSyntheticData(): string {
  const categories = ['Groceries', 'Restaurants', 'Transportation', 'Entertainment', 'Utilities', 'Shopping', 'Healthcare', 'Travel'];
  const accounts = ['Platinum Card', 'Rewards Visa', 'Checking Account', 'Debit Card'];
  const owners = ['Primary', 'Secondary', 'Shared'];
  
  const merchants: { [cat: string]: { name: string; statement: string }[] } = {
    Groceries: [
      { name: 'Fresh Mart', statement: 'FRESH MART #1234' },
      { name: 'Green Valley Foods', statement: 'GREEN VALLEY FOODS' },
      { name: 'City Grocery', statement: 'CITY GROCERY STORE' },
      { name: 'Organic Market', statement: 'ORGANIC MKT LLC' },
      { name: 'Corner Store', statement: 'CORNER STORE #567' },
    ],
    Restaurants: [
      { name: 'Bella Italia', statement: 'BELLA ITALIA REST' },
      { name: 'Golden Dragon', statement: 'GOLDEN DRAGON #42' },
      { name: 'Burger Joint', statement: 'BURGER JOINT LLC' },
      { name: 'Sushi Palace', statement: 'SUSHI PALACE' },
      { name: 'Taco Express', statement: 'TACO EXPRESS #789' },
    ],
    Transportation: [
      { name: 'Metro Transit', statement: 'METRO TRANSIT AUTH' },
      { name: 'City Parking', statement: 'CITY PARKING GARAGE' },
      { name: 'Fuel Stop', statement: 'FUEL STOP #321' },
      { name: 'Rideshare Co', statement: 'RIDESHARE CO' },
      { name: 'Auto Service', statement: 'AUTO SERVICE CTR' },
    ],
    Entertainment: [
      { name: 'Cinema Plus', statement: 'CINEMA PLUS #55' },
      { name: 'Streaming Service', statement: 'STREAMING SVC' },
      { name: 'Concert Hall', statement: 'CONCERT HALL TIX' },
      { name: 'Bowling Alley', statement: 'BOWLING ALLEY' },
      { name: 'Game Store', statement: 'GAME STORE #12' },
    ],
    Utilities: [
      { name: 'Electric Company', statement: 'ELECTRIC CO UTIL' },
      { name: 'Water Services', statement: 'WATER SERVICES' },
      { name: 'Internet Provider', statement: 'INTERNET PROV LLC' },
      { name: 'Gas Utility', statement: 'GAS UTILITY CO' },
      { name: 'Phone Service', statement: 'PHONE SVC #999' },
    ],
    Shopping: [
      { name: 'Department Store', statement: 'DEPT STORE #100' },
      { name: 'Electronics Hub', statement: 'ELECTRONICS HUB' },
      { name: 'Fashion Outlet', statement: 'FASHION OUTLET' },
      { name: 'Home Goods', statement: 'HOME GOODS STORE' },
      { name: 'Book Emporium', statement: 'BOOK EMPORIUM' },
    ],
    Healthcare: [
      { name: 'City Pharmacy', statement: 'CITY PHARMACY #77' },
      { name: 'Medical Clinic', statement: 'MEDICAL CLINIC' },
      { name: 'Vision Center', statement: 'VISION CENTER' },
      { name: 'Dental Office', statement: 'DENTAL OFFICE LLC' },
      { name: 'Health Mart', statement: 'HEALTH MART #33' },
    ],
    Travel: [
      { name: 'Airline Express', statement: 'AIRLINE EXPRESS' },
      { name: 'Hotel Suites', statement: 'HOTEL SUITES INC' },
      { name: 'Car Rental Co', statement: 'CAR RENTAL CO' },
      { name: 'Travel Agency', statement: 'TRAVEL AGENCY LLC' },
      { name: 'Resort Stay', statement: 'RESORT STAY #88' },
    ],
  };

  // Amount ranges by category
  const amountRanges: { [cat: string]: [number, number] } = {
    Groceries: [25, 150],
    Restaurants: [15, 80],
    Transportation: [10, 60],
    Entertainment: [12, 50],
    Utilities: [40, 200],
    Shopping: [20, 200],
    Healthcare: [15, 100],
    Travel: [100, 500],
  };

  // Seeded random for reproducibility
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const randomInt = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
  const randomChoice = <T,>(arr: T[]): T => arr[Math.floor(random() * arr.length)]!;

  const lines: string[] = [];
  lines.push('Date\tMerchant\tCategory\tAccount\tOriginal Statement\tNotes\tAmount\tTags\tOwner');

  for (let month = 1; month <= 12; month++) {
    for (const category of categories) {
      const transactionCount = randomInt(3, 6);
      const merchantList = merchants[category] ?? [];
      const [minAmount, maxAmount] = amountRanges[category] ?? [20, 100];

      for (let t = 0; t < transactionCount; t++) {
        const day = randomInt(1, 28);
        const date = `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const merchant = randomChoice(merchantList);
        const account = randomChoice(accounts);
        const owner = randomChoice(owners);
        const amount = -(randomInt(minAmount * 100, maxAmount * 100) / 100);

        lines.push(`${date}\t${merchant.name}\t${category}\t${account}\t${merchant.statement}\t\t${amount.toFixed(2)}\t\t${owner}`);
      }
    }
  }

  return lines.join('\n');
}

function parseTSV(tsv: string): Transaction[] {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];

  // Parse header to detect column mapping
  const headerLine = lines[0];
  if (!headerLine) return [];
  const headers = headerLine.split('\t');
  const mapping = detectColumnMapping(headers);

  // First pass: collect raw amounts to detect sign convention
  const rawAmounts: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = line.split('\t');
    if (mapping.amount >= 0) {
      const rawAmount = parseFloat(cols[mapping.amount] ?? '0') || 0;
      if (rawAmount !== 0) rawAmounts.push(rawAmount);
    }
  }

  const invertSign = detectSignConvention(rawAmounts);

  // Second pass: parse transactions
  const transactions: Transaction[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;

    const cols = line.split('\t');
    const getCol = (idx: number) => (idx >= 0 ? cols[idx] ?? '' : '');

    const rawAmount = parseFloat(getCol(mapping.amount)) || 0;
    const amount = invertSign ? -rawAmount : rawAmount;

    transactions.push({
      date: getCol(mapping.date),
      merchant: getCol(mapping.merchant),
      category: getCol(mapping.category),
      account: getCol(mapping.account),
      originalStatement: getCol(mapping.originalStatement),
      notes: getCol(mapping.notes),
      amount,
      tags: getCol(mapping.tags),
      owner: getCol(mapping.owner),
      fixedCategory: getCol(mapping.fixedCategory),
    });
  }

  return transactions;
}

function getYearMonth(dateStr: string): { year: number; month: number } | null {
  const parsed = parseDateString(dateStr);
  if (!parsed) return null;
  return { year: parsed.year, month: parsed.month };
}

function getAvailableYears(transactions: Transaction[]): number[] {
  const years = new Set<number>();
  for (const t of transactions) {
    const ym = getYearMonth(t.date);
    if (ym) years.add(ym.year);
  }
  return Array.from(years).sort((a, b) => b - a);
}

function pivotData(transactions: Transaction[], year: number): PivotData {
  const pivot: PivotData = {};

  for (const t of transactions) {
    const ym = getYearMonth(t.date);
    if (!ym || ym.year !== year) continue;

    const category = t.fixedCategory || t.category || 'Uncategorized';
    if (!pivot[category]) {
      pivot[category] = {};
    }
    const categoryData = pivot[category];
    if (categoryData) {
      categoryData[ym.month] = (categoryData[ym.month] ?? 0) + t.amount;
    }
  }

  return pivot;
}

function formatCurrency(amount: number): string {
  const absAmount = Math.abs(Math.round(amount));
  const formatted = absAmount.toLocaleString('en-US');
  return amount < 0 ? `-$${formatted}` : `$${formatted}`;
}

function calculateStats(monthlyData: { [month: number]: number }): { total: number; mean: number; median: number } {
  const values = Object.values(monthlyData).filter(v => v !== 0);
  if (values.length === 0) return { total: 0, mean: 0, median: 0 };

  const total = values.reduce((a, b) => a + b, 0);
  const mean = total / values.length;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0
    ? sorted[mid] ?? 0
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;

  return { total, mean, median };
}

function getTransactionsForCell(transactions: Transaction[], category: string, year: number, month: number): Transaction[] {
  return transactions.filter(t => {
    const ym = getYearMonth(t.date);
    return ym && ym.year === year && ym.month === month && (t.fixedCategory || t.category || 'Uncategorized') === category;
  });
}

function App() {
  const [tsvData, setTsvData] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>('amount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Load from localStorage on mount, or use synthetic data if empty
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const dataToUse = saved || generateSyntheticData();
    
    setTsvData(dataToUse);
    if (!saved) {
      localStorage.setItem(STORAGE_KEY, dataToUse);
    }
    const parsed = parseTSV(dataToUse);
    setTransactions(parsed);
    const years = getAvailableYears(parsed);
    if (years[0] !== undefined) {
      setSelectedYear(years[0]);
    }
  }, []);

  const handleTsvChange = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const value = target.value;
    setTsvData(value);
    localStorage.setItem(STORAGE_KEY, value);

    const parsed = parseTSV(value);
    setTransactions(parsed);

    const years = getAvailableYears(parsed);
    if (years[0] !== undefined && (selectedYear === null || !years.includes(selectedYear))) {
      setSelectedYear(years[0]);
    }
    setSelectedCell(null);
  };

  const availableYears = getAvailableYears(transactions);
  const pivot = selectedYear !== null ? pivotData(transactions, selectedYear) : {};
  const categories = Object.keys(pivot).sort();

  const handleCellClick = (category: string, month: number) => {
    if (selectedYear === null) return;
    setSelectedCell({ category, month, year: selectedYear });
  };

  const handleSortClick = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection(column === 'amount' ? 'desc' : 'asc');
    }
  };

  const filteredTransactions = selectedCell
    ? getTransactionsForCell(transactions, selectedCell.category, selectedCell.year, selectedCell.month)
    : [];

  const selectedTransactions = [...filteredTransactions].sort((a, b) => {
    const aVal = a[sortColumn];
    const bVal = b[sortColumn];
    const multiplier = sortDirection === 'asc' ? 1 : -1;

    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return (aVal - bVal) * multiplier;
    }
    return String(aVal).localeCompare(String(bVal)) * multiplier;
  });

  return (
    <div class="container">
      <h1>Category Spending Insights</h1>

      <div>
        <label>
          <strong>Paste your TSV data here:</strong>
        </label>
        <textarea
          value={tsvData}
          onInput={handleTsvChange}
          placeholder="Date&#9;Merchant&#9;Category&#9;Account&#9;Original Statement&#9;Notes&#9;Amount&#9;Tags&#9;Owner&#9;FixedCategory"
        />
      </div>

      {transactions.length > 0 && (
        <>
          <div class="year-selector">
            <strong>Year: </strong>
            {availableYears.map(year => (
              <button
                key={year}
                class={year === selectedYear ? 'active' : ''}
                onClick={() => {
                  setSelectedYear(year);
                  setSelectedCell(null);
                }}
              >
                {year}
              </button>
            ))}
          </div>

          {selectedYear !== null && categories.length > 0 && (() => {
            // Calculate column totals
            const monthlyTotals: { [month: number]: number } = {};

            for (const category of categories) {
              const monthlyData = pivot[category] ?? {};
              for (let month = 1; month <= 12; month++) {
                monthlyTotals[month] = (monthlyTotals[month] ?? 0) + (monthlyData[month] ?? 0);
              }
            }

            // Calculate proper stats from the monthly totals
            const totalStats = calculateStats(monthlyTotals);

            return (
              <table class="pivot-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    {MONTHS.map(m => (
                      <th key={m}>{m}</th>
                    ))}
                    <th>Total</th>
                    <th>Mean</th>
                    <th>Median</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map(category => {
                    const monthlyData = pivot[category] ?? {};
                    const stats = calculateStats(monthlyData);
                    return (
                      <tr key={category}>
                        <td>{category}</td>
                        {MONTHS.map((_, idx) => {
                          const month = idx + 1;
                          const value = monthlyData[month] ?? 0;
                          const isSelected = selectedCell?.category === category && selectedCell?.month === month;
                          return (
                            <td
                              key={month}
                              class={`clickable ${isSelected ? 'selected' : ''}`}
                              onClick={() => handleCellClick(category, month)}
                            >
                              {value !== 0 ? formatCurrency(value) : ''}
                            </td>
                          );
                        })}
                        <td>{formatCurrency(stats.total)}</td>
                        <td>{formatCurrency(stats.mean)}</td>
                        <td>{formatCurrency(stats.median)}</td>
                      </tr>
                    );
                  })}
                  <tr class="total-row">
                    <td><strong>Total</strong></td>
                    {MONTHS.map((_, idx) => {
                      const month = idx + 1;
                      const value = monthlyTotals[month] ?? 0;
                      return (
                        <td key={month}>
                          {value !== 0 ? formatCurrency(value) : ''}
                        </td>
                      );
                    })}
                    <td><strong>{formatCurrency(totalStats.total)}</strong></td>
                    <td><strong>{formatCurrency(totalStats.mean)}</strong></td>
                    <td><strong>{formatCurrency(totalStats.median)}</strong></td>
                  </tr>
                </tbody>
              </table>
            );
          })()}

          {selectedCell && selectedTransactions.length > 0 && (
            <div class="transactions">
              <h3>
                Transactions for {selectedCell.category} - {MONTHS[selectedCell.month - 1]} {selectedCell.year}
              </h3>
              <table>
                <thead>
                  <tr>
                    <th class="sortable" onClick={() => handleSortClick('date')}>
                      Date {sortColumn === 'date' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('merchant')}>
                      Merchant {sortColumn === 'merchant' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('category')}>
                      Category {sortColumn === 'category' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('account')}>
                      Account {sortColumn === 'account' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('originalStatement')}>
                      Original Statement {sortColumn === 'originalStatement' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('notes')}>
                      Notes {sortColumn === 'notes' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('tags')}>
                      Tags {sortColumn === 'tags' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('owner')}>
                      Owner {sortColumn === 'owner' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                    <th class="sortable" onClick={() => handleSortClick('amount')}>
                      Amount {sortColumn === 'amount' ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selectedTransactions.map((t, i) => (
                    <tr key={i}>
                      <td class="truncate" title={t.date}>{t.date}</td>
                      <td title={t.merchant}>{t.merchant}</td>
                      <td class="truncate" title={t.category}>{t.category}</td>
                      <td class="truncate" title={t.account}>{t.account}</td>
                      <td class="truncate" title={t.originalStatement}>{t.originalStatement}</td>
                      <td class="truncate" title={t.notes}>{t.notes}</td>
                      <td class="truncate" title={t.tags}>{t.tags}</td>
                      <td class="truncate" title={t.owner}>{t.owner}</td>
                      <td>{formatCurrency(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const appElement = document.getElementById('app');
if (appElement) {
  render(<App />, appElement);
}
