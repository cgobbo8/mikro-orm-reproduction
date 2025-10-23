import {
  Entity,
  MikroORM,
  PrimaryKey,
  Property,
  ManyToOne,
  Filter,
  Ref,
  ref,
  LoadStrategy,
} from "@mikro-orm/sqlite";

/**
 * Account entity - REQUIRED to trigger the bug
 *
 * This entity is referenced via an EAGER relation with strategy: 'joined'.
 * This forces MikroORM to consolidate all relations into a single SQL query with JOINs,
 * which triggers the buggy code path that adds the incorrect branching condition.
 *
 * Without this eager relation, MikroORM uses separate SELECT queries (SELECT_IN strategy),
 * which avoids the bug entirely.
 */
@Entity()
class Account {
  @PrimaryKey()
  id!: number;

  @Property()
  name: string;

  constructor(name: string) {
    this.name = name;
  }
}

/**
 * Document entity with soft delete filter
 */
@Entity()
@Filter({ name: "notDeleted", cond: { deleted: false }, default: true })
class Document {
  @PrimaryKey()
  id!: number;

  @Property()
  title: string;

  @Property({ default: false })
  deleted: boolean = false;

  constructor(title: string) {
    this.title = title;
  }
}

/**
 * User entity with TWO relations - BOTH required to reproduce the bug:
 *
 * 1. EAGER relation to Account with strategy: 'joined'
 *    → Forces MikroORM to use a single SQL query with JOINs instead of separate queries
 *    → This activates the code path containing the bug
 *
 * 2. NON-EAGER relation to Document (populated explicitly)
 *    → Has a global filter (soft delete)
 *    → When populated, triggers the incorrect branching condition
 *
 * The combination of these two relations is essential:
 * - Without Account: MikroORM uses SELECT_IN strategy (separate queries) → bug doesn't occur
 * - Without lastDocument: No filtered relation to populate → bug doesn't occur
 */
@Entity()
class User {
  @PrimaryKey()
  id!: number;

  @Property()
  email: string;

  @ManyToOne(() => Account, { eager: true, strategy: "joined" })
  account!: Ref<Account>;

  @ManyToOne(() => Document, { nullable: true })
  lastDocument?: Ref<Document>;

  constructor(email: string, account: Account) {
    this.email = email;
    this.account = ref(account);
  }
}

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    dbName: ":memory:",
    entities: [User, Document, Account],
    debug: ["query", "query-params"],
    allowGlobalContext: true,
    loadStrategy: LoadStrategy.SELECT_IN,
    forceUndefined: true,
  });
  await orm.schema.refreshDatabase();
});

afterAll(async () => {
  await orm.close(true);
});

test("findOne returns null when populating non-eager relation with soft-deleted entity", async () => {
  // Setup
  const account = orm.em.create(Account, { name: "Premium" });
  const document = orm.em.create(Document, { title: "Document 1" });
  await orm.em.flush();

  const user = orm.em.create(User, { email: "user@example.com", account });
  user.lastDocument = ref(document);
  await orm.em.flush();

  const userId = user.id;
  orm.em.clear();

  // Verify user exists before soft delete
  const userBefore = await orm.em.findOne(User, { id: userId });
  expect(userBefore).not.toBeNull();

  // Soft delete the document
  const docToDelete = await orm.em.findOneOrFail(
    Document,
    { id: document.id },
    {
      filters: { notDeleted: false },
    },
  );
  docToDelete.deleted = true;
  await orm.em.flush();
  orm.em.clear();

  // BUG: Populating a non-eager relation that has a global filter causes findOne to return null
  const userAfter = await orm.em.findOne(
    User,
    { id: userId },
    {
      populate: ["lastDocument"],
    },
  );

  // Expected: User entity is returned (it exists in the database)
  // Actual in v6.5.0+: Returns null
  //
  // Because the User has an EAGER Account relation with strategy: 'joined',
  // MikroORM generates a single query with JOINs:
  //
  //   SELECT u0.*, a1.*, d2.*
  //   FROM user AS u0
  //   INNER JOIN account AS a1 ON u0.account_id = a1.id
  //   LEFT JOIN document AS d2 ON u0.last_document_id = d2.id AND d2.deleted = false
  //   WHERE u0.id = 1
  //     AND (u0.last_document_id IS NULL OR d2.id IS NOT NULL)  -- ❌ INCORRECT
  //   LIMIT 1
  //
  // Since the document is soft-deleted:
  // - The LEFT JOIN condition "d2.deleted = false" doesn't match
  // - Therefore d2.id is NULL
  // - The branching condition evaluates to: (FALSE OR FALSE) = FALSE
  // - The entire user row is incorrectly filtered out
  //
  // Without the Account eager relation, MikroORM would use separate SELECT queries
  // (SELECT_IN strategy) and the bug would not occur.
  expect(userAfter).not.toBeNull();
  expect(userAfter?.email).toBe("user@example.com");
});

test("findOne works when relation is not populated", async () => {
  // Setup
  const account2 = orm.em.create(Account, { name: "Basic" });
  const document2 = orm.em.create(Document, {
    title: "Document 2",
    deleted: true,
  });
  const user2 = orm.em.create(User, {
    email: "user2@example.com",
    account: account2,
  });
  user2.lastDocument = ref(document2);
  await orm.em.flush();

  const userId2 = user2.id;
  orm.em.clear();

  // Without populate, the query works correctly
  const result = await orm.em.findOne(User, { id: userId2 });

  expect(result).not.toBeNull();
  expect(result?.email).toBe("user2@example.com");
});
