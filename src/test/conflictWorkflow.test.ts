import * as assert from "assert";
import { hasCompleteConflictMarkers } from "../conflictMarkers";

suite("Conflict workflow", () => {
  test("detects complete markers at EOF and without content padding", () => {
    assert.strictEqual(
      hasCompleteConflictMarkers("<<<<<<< .mine\n=======\n>>>>>>> .r2"),
      true
    );
    assert.strictEqual(
      hasCompleteConflictMarkers(
        "before\r\n<<<<<<< .mine\r\na\r\n=======\r\nb\r\n>>>>>>> .r2"
      ),
      true
    );
    assert.strictEqual(
      hasCompleteConflictMarkers("<<<<<<< .mine\nlocal"),
      false
    );
  });
});
