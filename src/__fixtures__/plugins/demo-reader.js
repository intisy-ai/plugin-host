export default {
  activate(ctx) {
    const store = ctx.services.get("demo-store:items");
    ctx.provide("commands", {
      commands: () => [{ name: "demo", description: `demo over ${store ? store.all().length : 0} items` }],
    });
  },
  deactivate() {},
};
