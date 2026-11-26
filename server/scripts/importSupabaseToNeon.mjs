import { Client } from "pg";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  throw new Error("Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL before running this one-time migration.");
}
if (sourceUrl === targetUrl) throw new Error("Source and target database URLs must be different.");

const tables = [
  "User", "Wallet", "Exchange", "Expense", "Receipt", "HouseholdMember",
  "IncomeSource", "IncomeEntry", "ExpenseCategory", "LedgerExpense",
  "Obligation", "ObligationOccurrence", "BalanceAdjustment", "Budget",
  "SavingsGoal", "Household", "HouseholdAccess", "HouseholdInvite",
  "PasswordResetToken", "TelegramBotUpdate", "TelegramReminderDelivery"
];

const source = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false } });
const target = new Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });

const ident = (value) => '"' + String(value).replace(/"/g, '""') + '"';
const tableRef = (table) => "public." + ident(table);

async function readRows(client, table) {
  const result = await client.query("SELECT * FROM " + tableRef(table));
  return result.rows;
}

async function insertRows(client, table, rows, conflict = "DO NOTHING") {
  if (!rows.length) return 0;
  const columns = Object.keys(rows[0]);
  const values = [];
  const tuples = rows.map((row) => {
    const placeholders = columns.map((column) => {
      values.push(row[column] === undefined ? null : row[column]);
      return "$" + values.length;
    });
    return "(" + placeholders.join(",") + ")";
  });
  const sql = "INSERT INTO " + tableRef(table) +
    " (" + columns.map(ident).join(",") + ") VALUES " + tuples.join(",") +
    " ON CONFLICT " + conflict;
  const result = await client.query(sql, values);
  return result.rowCount ?? 0;
}

async function verifyIds(client, table, ids, key = "id", type = "text") {
  if (!ids.length) return;
  const result = await client.query(
    "SELECT " + ident(key) + " FROM " + tableRef(table) +
    " WHERE " + ident(key) + " = ANY($1::" + type + "[])",
    [ids]
  );
  if (result.rowCount !== ids.length) {
    throw new Error("Verification failed for " + table + ": expected " + ids.length +
      " distinct source records, found " + result.rowCount + ".");
  }
}

async function main() {
  await source.connect();
  await target.connect();

  try {
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sourceRows = {};
    for (const table of tables) sourceRows[table] = await readRows(source, table);

    const sourceUsers = sourceRows.User;
    const targetUsers = (await readRows(target, "User"));
    if (targetUsers.length === 0) throw new Error("Target has no account; refusing an unanchored import.");

    const emailMatches = [];
    for (const sourceUser of sourceUsers) {
      const match = targetUsers.find((targetUser) =>
        targetUser.email.toLowerCase() === sourceUser.email.toLowerCase()
      );
      if (match) emailMatches.push({ sourceUser, targetUser: match });
    }
    if (emailMatches.length !== 1) {
      throw new Error("Expected exactly one matching account by email; found " + emailMatches.length + ".");
    }

    const primary = emailMatches[0];
    const userMap = new Map(sourceUsers.map((user) => [user.id, user.id]));
    userMap.set(primary.sourceUser.id, primary.targetUser.id);

    for (const sourceUser of sourceUsers) {
      const targetById = targetUsers.find((user) => user.id === sourceUser.id);
      const targetByEmail = targetUsers.find((user) =>
        user.email.toLowerCase() === sourceUser.email.toLowerCase()
      );
      if (targetById && targetById.email.toLowerCase() !== sourceUser.email.toLowerCase()) {
        throw new Error("User ID collision detected; no data was imported.");
      }
      if (targetByEmail && sourceUser.id !== primary.sourceUser.id &&
          targetByEmail.id !== sourceUser.id) {
        throw new Error("Unexpected duplicate account email in target; no data was imported.");
      }
    }

    const sourceHouseholds = sourceRows.Household;
    const targetHouseholds = await readRows(target, "Household");
    const primarySourceHouseholds = sourceHouseholds.filter((h) => h.ownerUserId === primary.sourceUser.id);
    const primaryTargetHouseholds = targetHouseholds.filter((h) => h.ownerUserId === primary.targetUser.id);
    if (primarySourceHouseholds.length !== 1 || primaryTargetHouseholds.length !== 1) {
      throw new Error("Could not uniquely match the primary household; no data was imported.");
    }

    const householdMap = new Map(sourceHouseholds.map((h) => [h.id, h.id]));
    householdMap.set(primarySourceHouseholds[0].id, primaryTargetHouseholds[0].id);
    for (const household of sourceHouseholds) {
      const existing = targetHouseholds.find((candidate) => candidate.id === household.id);
      if (existing && household.id !== primarySourceHouseholds[0].id &&
          existing.ownerUserId !== (userMap.get(household.ownerUserId) ?? household.ownerUserId)) {
        throw new Error("Household ID collision detected; no data was imported.");
      }
    }

    const sourceCategories = sourceRows.ExpenseCategory;
    const targetCategories = await readRows(target, "ExpenseCategory");
    const categoryMap = new Map();
    for (const category of sourceCategories) {
      const mappedUserId = category.userId ? (userMap.get(category.userId) ?? category.userId) : null;
      const targetMatch = targetCategories.find((candidate) =>
        candidate.slug === category.slug && (candidate.userId ?? null) === mappedUserId
      );
      if (category.userId == null && !targetMatch) {
        throw new Error("A built-in category is missing from target: " + category.slug);
      }
      categoryMap.set(category.id, targetMatch ? targetMatch.id : category.id);
      const idCollision = targetCategories.find((candidate) => candidate.id === category.id);
      if (idCollision && (idCollision.slug !== category.slug ||
          (idCollision.userId ?? null) !== mappedUserId)) {
        throw new Error("Category ID collision detected; no data was imported.");
      }
    }

    const targetAccess = await readRows(target, "HouseholdAccess");
    const mapRow = (table, original) => {
      const row = { ...original };
      if (row.userId && userMap.has(row.userId)) row.userId = userMap.get(row.userId);
      if (table === "Household") {
        row.id = householdMap.get(row.id) ?? row.id;
        row.ownerUserId = userMap.get(row.ownerUserId) ?? row.ownerUserId;
      }
      if (table === "HouseholdAccess" || table === "HouseholdInvite") {
        row.householdId = householdMap.get(row.householdId) ?? row.householdId;
      }
      if (table === "HouseholdInvite") {
        row.createdByUserId = userMap.get(row.createdByUserId) ?? row.createdByUserId;
        if (row.acceptedByUserId) {
          row.acceptedByUserId = userMap.get(row.acceptedByUserId) ?? row.acceptedByUserId;
        }
      }
      if ((table === "LedgerExpense" || table === "Budget") && row.categoryId) {
        row.categoryId = categoryMap.get(row.categoryId) ?? row.categoryId;
      }
      return row;
    };

    await source.query("COMMIT");
    await target.query("BEGIN");

    // Keep the already-working Neon login credentials and ID for the matching account.
    // Bring across its financial preferences without replacing its password or session version.
    await target.query(
      'UPDATE public."User" SET "timezone"=$1,"locale"=$2,"openingBalance"=$3,' +
      '"openingBalanceDate"=$4,"openingBalanceConfigured"=$5,"updatedAt"=$6 WHERE id=$7',
      [
        primary.sourceUser.timezone,
        primary.sourceUser.locale,
        primary.sourceUser.openingBalance,
        primary.sourceUser.openingBalanceDate,
        primary.sourceUser.openingBalanceConfigured,
        primary.sourceUser.updatedAt,
        primary.targetUser.id
      ]
    );

    await insertRows(target, "User", sourceRows.User.filter((u) => u.id !== primary.sourceUser.id));
    const mappedPrimaryHouse = mapRow("Household", primarySourceHouseholds[0]);
    await target.query(
      'UPDATE public."Household" SET "name"=$1,"updatedAt"=$2 WHERE id=$3 AND "ownerUserId"=$4',
      [mappedPrimaryHouse.name, mappedPrimaryHouse.updatedAt, primary.targetUser.id === mappedPrimaryHouse.ownerUserId
        ? mappedPrimaryHouse.id : primaryTargetHouseholds[0].id, primary.targetUser.id]
    );

    const importPlan = [
      ["Household", sourceRows.Household.filter((h) => h.id !== primarySourceHouseholds[0].id)],
      ["HouseholdMember", sourceRows.HouseholdMember],
      ["ExpenseCategory", sourceRows.ExpenseCategory.filter((c) => {
        if (c.userId == null) return !targetCategories.some((t) => t.slug === c.slug && t.userId == null);
        const mappedUserId = userMap.get(c.userId) ?? c.userId;
        return !targetCategories.some((t) => t.slug === c.slug && (t.userId ?? null) === mappedUserId);
      })],
      ["Wallet", sourceRows.Wallet],
      ["Exchange", sourceRows.Exchange],
      ["Receipt", sourceRows.Receipt],
      ["Expense", sourceRows.Expense],
      ["IncomeSource", sourceRows.IncomeSource],
      ["Obligation", sourceRows.Obligation],
      ["SavingsGoal", sourceRows.SavingsGoal],
      ["HouseholdAccess", sourceRows.HouseholdAccess.filter((a) =>
        !(a.householdId === primarySourceHouseholds[0].id && a.userId === primary.sourceUser.id)
      )],
      ["HouseholdInvite", sourceRows.HouseholdInvite],
      ["LedgerExpense", sourceRows.LedgerExpense],
      ["IncomeEntry", sourceRows.IncomeEntry],
      ["ObligationOccurrence", sourceRows.ObligationOccurrence],
      ["BalanceAdjustment", sourceRows.BalanceAdjustment],
      ["Budget", sourceRows.Budget],
      ["PasswordResetToken", sourceRows.PasswordResetToken],
      ["TelegramBotUpdate", sourceRows.TelegramBotUpdate],
      ["TelegramReminderDelivery", sourceRows.TelegramReminderDelivery]
    ];

    const inserted = {};
    for (const [table, rows] of importPlan) {
      inserted[table] = await insertRows(target, table, rows.map((row) => mapRow(table, row)));
    }

    const expected = {};
    for (const table of tables) {
      if (table === "HouseholdAccess") continue;
      let rows = sourceRows[table].map((row) => mapRow(table, row));
      if (table === "ExpenseCategory") rows = sourceRows[table].map((row) => ({ ...row, id: categoryMap.get(row.id) }));
      if (table === "User") rows = sourceRows.User.map((row) => ({ ...row, id: userMap.get(row.id) }));
      if (table === "Household") rows = sourceRows.Household.map((row) => ({ ...row, id: householdMap.get(row.id) }));
      if (table === "TelegramBotUpdate") {
        await verifyIds(target, table, rows.map((row) => String(row.updateId)), "updateId", "bigint");
      } else {
        await verifyIds(target, table, rows.map((row) => row.id));
      }
      expected[table] = rows.length;
    }

    const accessPairs = sourceRows.HouseholdAccess.map((row) => ({
      householdId: householdMap.get(row.householdId) ?? row.householdId,
      userId: userMap.get(row.userId) ?? row.userId
    }));
    const accessCheck = await target.query(
      'SELECT count(*)::int AS count FROM public."HouseholdAccess" a ' +
      'JOIN unnest($1::text[],$2::text[]) AS p("householdId","userId") ' +
      'ON a."householdId"=p."householdId" AND a."userId"=p."userId"',
      [accessPairs.map((p) => p.householdId), accessPairs.map((p) => p.userId)]
    );
    if (accessCheck.rows[0].count !== accessPairs.length) {
      throw new Error("Household access verification failed; transaction will be rolled back.");
    }

    await target.query("COMMIT");
    console.log(JSON.stringify({
      status: "success",
      sourceRows: Object.fromEntries(tables.map((table) => [table, sourceRows[table].length])),
      insertedRows: inserted,
      verifiedRows: expected,
      householdAccessVerified: accessCheck.rows[0].count,
      primaryAccount: "matched by email; existing Neon password and account ID preserved"
    }, null, 2));
  } catch (error) {
    try { await source.query("ROLLBACK"); } catch {}
    try { await target.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error("Supabase-to-Neon import failed:", error.message);
  process.exitCode = 1;
});
