import net from "node:net";

const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[2]) });
socket.on("error", () => process.exit(1));
process.stdin.pipe(socket);
socket.pipe(process.stdout);
