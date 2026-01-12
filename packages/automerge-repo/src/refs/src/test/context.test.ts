import { describe, it, expect, beforeEach } from "vitest";
import { Repo } from "@automerge/automerge-repo";
import type { DocHandle } from "@automerge/automerge-repo";
import { ref } from "../factory";

type TestDoc = {
  content: string;
  doc: { title: string };
  items: Array<{ text: string }>;
  todos: Array<{ id: string; title: string; done: boolean }>;
  users: Array<{ id: string; name: string }>;
  item: { title: string; count: number; done?: boolean };
  count: number;
  title: string;
};

describe("RefContext", () => {
  let repo: Repo;
  let handle: DocHandle<TestDoc>;

  beforeEach(() => {
    repo = new Repo();
    handle = repo.create<TestDoc>();
  });

  describe("splice", () => {
    it("should splice text using MutableText", () => {
      handle.change((d) => {
        d.content = "hello world";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        text.splice(0, 5, "goodbye");
      });

      expect(textRef.value()).toBe("goodbye world");
    });

    it("should work with nested paths", () => {
      handle.change((d) => {
        d.doc = { title: "hello" };
      });

      const titleRef = ref(handle, "doc", "title");

      titleRef.change((text) => {
        text.splice(0, 0, "say ");
      });

      expect(titleRef.value()).toBe("say hello");
    });

    it("should work with array paths", () => {
      handle.change((d) => {
        d.items = [{ text: "first" }];
      });

      const itemRef = ref(handle, "items", 0, "text");

      itemRef.change((text) => {
        text.splice(5, 0, " item");
      });

      expect(itemRef.value()).toBe("first item");
    });
  });

  describe("updateText", () => {
    it("should update entire text using MutableText", () => {
      handle.change((d) => {
        d.content = "hello";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        text.updateText("goodbye");
      });

      expect(textRef.value()).toBe("goodbye");
    });

    it("should work with nested paths", () => {
      handle.change((d) => {
        d.doc = { title: "old title" };
      });

      const titleRef = ref(handle, "doc", "title");

      titleRef.change((text) => {
        text.updateText("new title");
      });

      expect(titleRef.value()).toBe("new title");
    });
  });

  describe("MutableText with stable refs", () => {
    it("should work with match pattern refs", () => {
      handle.change((d) => {
        d.todos = [
          { id: "a", title: "first", done: false },
          { id: "b", title: "second", done: false },
        ];
      });

      // Get stable ref using match pattern to find by id
      const titleRef = ref(handle, "todos", { id: "a" }, "title");

      // Swap first two elements by inserting second at index 0 and deleting old second
      handle.change((d: any) => {
        d.todos.insertAt(0, { id: "c", title: "third", done: false });
        d.todos.deleteAt(2); // Delete old second (now at index 2)
      });

      // Match pattern finds the item with id "a" (now at index 1)
      titleRef.change((text) => {
        text.updateText("updated first");
      });

      const todos = handle.doc()?.todos;
      expect(todos[1].title).toBe("updated first");
      expect(todos[0].title).toBe("third");
    });

    it("should work with where clause refs", () => {
      handle.change((d) => {
        d.users = [
          { id: "user1", name: "Alice" },
          { id: "user2", name: "Bob" },
        ];
      });

      const aliceRef = ref(handle, "users", { id: "user1" }, "name");

      aliceRef.change((name) => {
        name.updateText("Alice Smith");
      });

      const users = handle.doc()?.users;
      expect(users[0].name).toBe("Alice Smith");
    });
  });

  describe("regular mutation without MutableText", () => {
    it("should allow regular mutation for objects", () => {
      handle.change((d) => {
        d.item = { title: "test", count: 0 };
      });

      const itemRef = ref(handle, "item");

      itemRef.change((item) => {
        item.count++;
        item.done = true;
      });

      const item = handle.doc()?.item;
      expect(item.count).toBe(1);
      expect(item.done).toBe(true);
    });

    it("should allow returning new value for primitives", () => {
      handle.change((d) => {
        d.count = 5;
      });

      const countRef = ref(handle, "count");

      countRef.change((count) => {
        return count + 1;
      });

      expect(handle.doc()?.count).toBe(6);
    });

    it("should pass plain string for non-Automerge text strings", () => {
      handle.change((d) => {
        d.title = "hello";
      });

      const titleRef = ref(handle, "title");

      titleRef.change((title) => {
        // Should receive MutableText which has splice method
        expect(typeof title.splice).toBe("function");
        expect(typeof title.updateText).toBe("function");
      });
    });
  });

  describe("string methods via Proxy forwarding", () => {
    it("should support toUpperCase()", () => {
      handle.change((d) => {
        d.content = "hello world";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.toUpperCase();
      });

      expect(textRef.value()).toBe("HELLO WORLD");
    });

    it("should support toLowerCase()", () => {
      handle.change((d) => {
        d.content = "HELLO WORLD";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.toLowerCase();
      });

      expect(textRef.value()).toBe("hello world");
    });

    it("should support slice()", () => {
      handle.change((d) => {
        d.content = "hello world";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.slice(0, 5);
      });

      expect(textRef.value()).toBe("hello");
    });

    it("should support trim()", () => {
      handle.change((d) => {
        d.content = "  hello  ";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.trim();
      });

      expect(textRef.value()).toBe("hello");
    });

    it("should support length property", () => {
      handle.change((d) => {
        d.content = "hello";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        expect(text.length).toBe(5);
      });
    });

    it("should support charAt()", () => {
      handle.change((d) => {
        d.content = "hello";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        expect(text.charAt(0)).toBe("h");
        expect(text.charAt(4)).toBe("o");
      });
    });

    it("should support index access", () => {
      handle.change((d) => {
        d.content = "hello";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        expect(text[0]).toBe("h");
        expect(text[4]).toBe("o");
      });
    });

    it("should support concat()", () => {
      handle.change((d) => {
        d.content = "hello";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.concat(" world");
      });

      expect(textRef.value()).toBe("hello world");
    });

    it("should support replace()", () => {
      handle.change((d) => {
        d.content = "hello world";
      });

      const textRef = ref(handle, "content");

      textRef.change((text) => {
        return text.replace("world", "there");
      });

      expect(textRef.value()).toBe("hello there");
    });

    it("should mix string methods with Automerge mutations", () => {
      handle.change((d) => {
        d.content = "hello world";
      });

      const textRef = ref(handle, "content");

      // First use a string method
      textRef.change((text) => {
        return text.toUpperCase();
      });

      expect(textRef.value()).toBe("HELLO WORLD");

      // Then use Automerge splice
      textRef.change((text) => {
        text.splice(6, 5, "THERE");
      });

      expect(textRef.value()).toBe("HELLO THERE");
    });
  });
});
