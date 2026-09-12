import * as assert from "assert";
import { cancelDebounces, debounce } from "../decorators";

class DebounceFixture {
  public calls = 0;

  @debounce(20)
  public trigger(): void {
    this.calls += 1;
  }
}

suite("Decorator Lifecycle Tests", () => {
  test("cancelDebounces cancels pending callbacks and allows reuse", async () => {
    const fixture = new DebounceFixture();

    fixture.trigger();
    cancelDebounces(fixture);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fixture.calls, 0);

    fixture.trigger();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(fixture.calls, 1);
  });
});
