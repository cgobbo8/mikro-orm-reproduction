# Bug Report: findOne returns null when populating non-eager relation with global filter

## Summary

`findOne()` incorrectly returns `null` when:
1. An entity has another eager `@ManyToOne` relation with `strategy: 'joined'`
2. The same entity has a non-eager `@ManyToOne` relation to another entity
3. The related entity has a global filter (e.g., soft delete)
4. The non-eager relation is populated explicitly via `populate` option
5. The related entity instance is filtered out by the global filter

**Expected**: The parent entity should be returned with the filtered relation as `null`/`undefined`
**Actual**: `findOne()` returns `null` as if the parent entity doesn't exist

**Note**: The eager relation with `strategy: 'joined'` is essential to trigger the bug, as it forces MikroORM to consolidate all relations into a single SQL query with JOINs.

## Environment

- **MikroORM version**: 6.5.0+ (bug introduced in v6.5.0)
- **Driver**: All drivers (SQLite, PostgreSQL, MySQL)
- **Introduced by**: Commit `2d1b889` - "refactor handling of filters on relations"

## Reproduction

See `src/bug.test.ts` for a minimal reproduction with SQLite in-memory database.

### Setup

```typescript
// Entity with global filter (soft delete)
@Entity()
@Filter({ name: 'notDeleted', cond: { deleted: false }, default: true })
class Document {
  @Property({ default: false })
  deleted: boolean = false;
}

// Needed to trigger the bug - forces MikroORM to use JOINs
@Entity()
class Account {
  @PrimaryKey()
  id!: number;

  @Property()
  name: string;
}

// Parent entity with TWO relations (both required to trigger the bug):
// 1. EAGER relation with strategy: 'joined' → forces single query with JOINs
// 2. NON-EAGER relation with global filter → triggers branching condition bug
@Entity()
class User {
  @ManyToOne(() => Account, { eager: true, strategy: 'joined' })
  account!: Ref<Account>;

  @ManyToOne(() => Document, { nullable: true })  // Not eager
  lastDocument?: Ref<Document>;
}
```

### Steps

1. Create an Account and a Document
2. Create a User with both Account (eager) and Document (non-eager) relations
3. Soft-delete the Document
4. Query the User with explicit populate:
   ```typescript
   await orm.em.findOne(User, { id }, { populate: ['lastDocument'] })
   ```

### Result

The query adds an incorrect branching condition:
```sql
SELECT u0.*, a1.*, d2.*
FROM user AS u0
INNER JOIN account AS a1 ON u0.account_id = a1.id
LEFT JOIN document AS d2 ON u0.last_document_id = d2.id AND d2.deleted = false
WHERE u0.id = 1
  AND (u0.last_document_id IS NULL OR d2.id IS NOT NULL)  -- INCORRECT
LIMIT 1
```

Since the document is soft-deleted:
- The LEFT JOIN condition `d2.deleted = false` doesn't match
- Therefore `d2.id` is NULL
- The condition evaluates to: `(FALSE OR FALSE)` = `FALSE`
- The entire row is filtered out, returning `null`

## Root Cause

The bug was introduced in v6.5.0, likely by commit `2d1b889`:
> sql: refactor handling of filters on relations (#6760, #6784)

This refactoring appears to incorrectly add a branching condition when:
- A relation has a global filter
- The relation is not eager but is populated explicitly
- Another relation on the same entity is eager with `strategy: 'joined'` (required to trigger the bug)

**Why the second eager relation is required**: When an entity has an eager relation with `strategy: 'joined'`, MikroORM consolidates all relations into a single SQL query with JOINs. This triggers the buggy code path that adds the incorrect branching condition. Without the eager relation, MikroORM uses separate SELECT queries (SELECT_IN strategy), which avoids the bug entirely.

The branching condition `(foreign_key IS NULL OR related_id IS NOT NULL)` is meant to optimize JOINs but doesn't account for filtered relations where the JOIN may not match due to the filter, not due to the absence of the related entity.

## Impact

This bug affects production applications where:
- Entities have soft-delete or other global filters
- Relations are populated on demand rather than eagerly loaded
- Users receive "not found" errors for entities that exist in the database

In our case, this prevented users from authenticating because their profile lookup failed.

## Workarounds

### 1. Remove populate hint (if not needed)
```typescript
// Instead of
await findOne(id, { populate: ['lastDocument'] })

// Use
await findOne(id)
```

### 2. Disable the global filter for the query
```typescript
await findOne(id, {
  populate: ['lastDocument'],
  filters: { notDeleted: false }
})
```

### 3. Remove the foreign key reference to the soft-deleted entity
```typescript
// If the related entity is soft-deleted, set the relation to null
user.lastDocument = null;
await orm.em.flush();

// Then the query will work correctly
await findOne(id, { populate: ['lastDocument'] })
```

### 4. Downgrade to v6.4.16
The last working version before the bug was introduced.

## Expected Fix

The branching condition should either:
1. Not be added when a relation has a global filter, OR
2. Be adjusted to account for filtered relations:
   ```sql
   -- Current (wrong)
   WHERE entity.id = X AND (entity.relation_id IS NULL OR related.id IS NOT NULL)

   -- Should be
   WHERE entity.id = X
   -- No branching condition, or different logic for filtered relations
   ```

## References

- Likely introduced by: https://github.com/mikro-orm/mikro-orm/commit/2d1b889
- Related issues: #6760, #6784 (issues that commit 2d1b889 was supposed to fix)
- Similar issues: #6826, #6824 (partial fixes for branching conditions in v6.5.3)
