export default {
  activate(ctx) {
    ctx.services.register("demo-store:items", { all: () => ["one", "two"] });
    ctx.events.subscribe("config.changed", () => {});
    ctx.provide("settings", {
      schema: () => ({ fields: [{ key: "limit", type: "number", label: "Limit" }] }),
      run: async (actionId) => ({ ok: actionId === "refresh", message: actionId }),
    });
  },
  deactivate() {},
};
