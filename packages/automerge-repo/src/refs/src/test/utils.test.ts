import { describe, it, expect, beforeEach } from "vitest";
import { Repo } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import * as Automerge from "@automerge/automerge";
import { cursor } from "../utils";
import { ref, findRef, RefUrl } from "../index";
import { Ref } from "../ref";
import { CURSOR_MARKER } from "../types";

describe("utils", () => {
  describe("cursor", () => {
    it("should create a cursor marker", () => {
      const marker = cursor(0, 5);
      expect(marker[CURSOR_MARKER]).toBe(true);
      expect(marker.start).toBe(0);
      expect(marker.end).toBe(5);
    });

    it("should work with different positions", () => {
      const marker = cursor(10, 20);
      expect(marker[CURSOR_MARKER]).toBe(true);
      expect(marker.start).toBe(10);
      expect(marker.end).toBe(20);
    });
  });

  describe("ref", () => {
    let repo: Repo;
    let handle: DocHandle<any>;

    beforeEach(() => {
      repo = new Repo();
      handle = repo.create();
    });

    it("should create a ref with variadic arguments", () => {
      handle.change((d) => {
        d.user = { name: "Alice" };
      });

      const nameRef = ref(handle, "user", "name");
      expect(nameRef.value()).toBe("Alice");
    });

    it("should work with numeric indices", () => {
      handle.change((d) => {
        d.items = ["a", "b", "c"];
      });

      const itemRef = ref(handle, "items", 1);
      expect(itemRef.value()).toBe("b");
    });

    it("should work with where clauses", () => {
      handle.change((d) => {
        d.todos = [
          { id: "a", title: "First" },
          { id: "b", title: "Second" },
        ];
      });

      const todoRef = ref(handle, "todos", { id: "b" }, "title");
      expect(todoRef.value()).toBe("Second");
    });

    it("should work with numeric indices", () => {
      handle.change((d) => {
        d.items = [{ name: "A" }, { name: "B" }];
      });

      const indexRef = ref(handle, "items", 0, "name");
      expect(indexRef.value()).toBe("A");
    });

    it("should handle deep paths", () => {
      handle.change((d) => {
        d.app = {
          settings: {
            theme: {
              color: "blue",
            },
          },
        };
      });

      const colorRef = ref(handle, "app", "settings", "theme", "color");
      expect(colorRef.value()).toBe("blue");
    });
  });

  describe("findRef", () => {
    let repo: Repo;
    let handle: DocHandle<any>;

    beforeEach(() => {
      repo = new Repo();
      handle = repo.create();
    });

    it("should reconstruct a ref from its URL", async () => {
      handle.change((d: any) => {
        d.user = { name: "Alice", age: 30 };
      });

      const nameRef = ref(handle, "user", "name");
      const url = nameRef.url;

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe("Alice");
      expect(foundRef.url).toBe(url);
    });

    it("should handle nested paths", async () => {
      handle.change((d: any) => {
        d.app = {
          settings: {
            theme: { color: "blue" },
          },
        };
      });

      const colorRef = ref(handle, "app", "settings", "theme", "color");
      const url = colorRef.url;

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe("blue");
    });

    it("should handle array indices", async () => {
      handle.change((d: any) => {
        d.todos = [
          { title: "first", done: false },
          { title: "second", done: true },
        ];
      });

      const titleRef = ref(handle, "todos", 0, "title");
      const url = titleRef.url;

      // Reorder array
      handle.change((d: any) => {
        d.todos.insertAt(0, { title: "zeroth", done: false });
      });

      // With numeric indices, ref still points to position 0 (now "zeroth")
      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe("zeroth");
    });

    it("should handle where clauses", async () => {
      handle.change((d: any) => {
        d.users = [
          { id: "user1", name: "Alice" },
          { id: "user2", name: "Bob" },
        ];
      });

      const aliceRef = ref(handle, "users", { id: "user1" }, "name");
      const url = aliceRef.url;

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe("Alice");
    });

    it("should handle cursor ranges", async () => {
      handle.change((d: any) => {
        d.text = "hello world";
      });

      const rangeRef = ref(handle, "text", cursor(0, 5));
      const url = rangeRef.url;

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe("hello");
    });

    it("should handle refs with heads", async () => {
      handle.change((d: any) => {
        d.counter = 1;
      });

      // Get heads using Automerge.getHeads (hex format) not handle.heads() (base58)
      const heads1 = Automerge.getHeads(handle.doc());

      handle.change((d: any) => {
        d.counter = 2;
      });

      const counterRef = new Ref(handle, ["counter"], { heads: heads1 });
      const url = counterRef.url;

      // Verify URL format: automerge:docId/path#head1,head2
      expect(url).toMatch(/^automerge:[^/]+\/counter#.+$/);
      expect(counterRef.value()).toBe(1); // Should see old value

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toBe(1); // Should see old value
      expect(foundRef.url).toBe(url);
    });

    it("should throw on invalid URL format", async () => {
      await expect(findRef(repo, "not-a-valid-url" as RefUrl)).rejects.toThrow(
        "Invalid ref URL"
      );
      await expect(findRef(repo, "wrong:abc/path" as RefUrl)).rejects.toThrow(
        "Invalid ref URL"
      );
    });

    it("should handle root path (document ref)", async () => {
      handle.change((d: any) => {
        d.value = 42;
      });

      const rootRef = ref(handle);
      const url = rootRef.url;

      const foundRef = await findRef(repo, url);
      expect(foundRef.value()).toEqual({ value: 42 });
    });
  });
});
