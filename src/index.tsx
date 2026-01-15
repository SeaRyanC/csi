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

type SortColumn = 'date' | 'merchant' | 'category' | 'account' | 'originalStatement' | 'notes' | 'tags' | 'owner' | 'amount';
type SortDirection = 'asc' | 'desc';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STORAGE_KEY = 'csi-tsv-data';

function parseTSV(tsv: string): Transaction[] {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];

  const transactions: Transaction[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;

    const cols = line.split('\t');
    const rawAmount = parseFloat(cols[6] ?? '0') || 0;
    const amount = -rawAmount; // Invert sign: treat negative as positive and vice versa

    transactions.push({
      date: cols[0] ?? '',
      merchant: cols[1] ?? '',
      category: cols[2] ?? '',
      account: cols[3] ?? '',
      originalStatement: cols[4] ?? '',
      notes: cols[5] ?? '',
      amount,
      tags: cols[7] ?? '',
      owner: cols[8] ?? '',
      fixedCategory: cols[9] ?? '',
    });
  }

  return transactions;
}

function getYearMonth(dateStr: string): { year: number; month: number } | null {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0] ?? '0', 10);
  const month = parseInt(parts[1] ?? '0', 10);
  if (isNaN(year) || isNaN(month)) return null;
  return { year, month };
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

    const category = t.fixedCategory || 'Uncategorized';
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
    return ym && ym.year === year && ym.month === month && (t.fixedCategory || 'Uncategorized') === category;
  });
}

function App() {
  const [tsvData, setTsvData] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [selectedCell, setSelectedCell] = useState<CellSelection | null>(null);
  const [sortColumn, setSortColumn] = useState<SortColumn>('amount');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Load from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setTsvData(saved);
      const parsed = parseTSV(saved);
      setTransactions(parsed);
      const years = getAvailableYears(parsed);
      if (years[0] !== undefined) {
        setSelectedYear(years[0]);
      }
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

          {selectedYear !== null && categories.length > 0 && (
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
              </tbody>
            </table>
          )}

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
