import * as assert from "assert";
import {
  createStagingChangelist,
  isStagingChangelist,
  normalizeWorkingCopyRoot,
  parseStagingChangelist,
  STAGING_CHANGELIST_PREFIX
} from "../stagingModel";

suite("Staging Model", () => {
  test("tracks an ordinary staged file", () => {
    const name = createStagingChangelist();
    assert.equal(name, STAGING_CHANGELIST_PREFIX);
    assert.equal(isStagingChangelist(name), true);
    assert.deepEqual(parseStagingChangelist(name), {
      wasUnversioned: false
    });
  });

  test("persists original changelist in the internal name", () => {
    const original = "review later / кириллица";
    const name = createStagingChangelist(original);
    assert.equal(isStagingChangelist(name), true);
    assert.deepEqual(parseStagingChangelist(name), {
      originalChangelist: original,
      wasUnversioned: false
    });
  });

  test("marks files that were unversioned before staging", () => {
    const name = createStagingChangelist(undefined, true);
    assert.deepEqual(parseStagingChangelist(name), {
      wasUnversioned: true
    });
  });

  test("persists staging-created directory roots", () => {
    const root = "/tmp/work tree/каталог";
    const name = createStagingChangelist(undefined, true, root);
    assert.equal(isStagingChangelist(name), true);
    assert.deepEqual(parseStagingChangelist(name), {
      wasUnversioned: true,
      createdDirectoryRoot: root
    });
  });

  test("does not claim malformed or user changelists", () => {
    assert.equal(isStagingChangelist("feature-a"), false);
    assert.equal(parseStagingChangelist("feature-a"), undefined);
    assert.equal(
      parseStagingChangelist(`${STAGING_CHANGELIST_PREFIX}:c:not-hex`),
      undefined
    );
    assert.equal(
      parseStagingChangelist(`${STAGING_CHANGELIST_PREFIX}:u:d:not-hex`),
      undefined
    );
  });

  test("normalizes equivalent physical working-copy roots", () => {
    assert.equal(
      normalizeWorkingCopyRoot("/tmp/example/../wc/"),
      normalizeWorkingCopyRoot("/tmp/wc")
    );
  });
});
