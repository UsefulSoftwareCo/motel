using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "motel", worker = (
      modules = [(name = "motel.mjs", esModule = embed "../dist/workerd/motel.mjs")],
      compatibilityDate = "2026-09-01",
      compatibilityFlags = ["nodejs_compat"],
      bindings = [
        (name = "STORE", durableObjectNamespace = "MotelCollector"),
        (name = "ASSETS", service = "assets")
      ],
      durableObjectNamespaces = [(className = "MotelCollector", uniqueKey = "motel", enableSql = true)],
      durableObjectStorage = (localDisk = "data")
    )),
    (name = "assets", disk = (path = "./web/dist")),
    (name = "data", disk = (path = "./.local/workerd-data", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:27687", http = (), service = "motel")]
);
