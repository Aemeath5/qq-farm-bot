/**
 * PB 解码 CLI 入口
 *
 * 用法:
 *   pnpm -C core exec tsx src/cli/pb-decode.ts --decode <data> [--hex] [--gate] [--type <FQN>]
 *   pnpm -C core exec tsx src/cli/pb-decode.ts --verify
 *   pnpm pb-decode -- --decode <data> --gate
 */

const { loadProto } = require('../utils/proto');
const { verifyMode, decodeMode, printHelp } = require('../utils/decode');

async function main(): Promise<void> {
    const args = process.argv.slice(2).filter((arg) => arg !== '--');

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        printHelp();
        return;
    }

    await loadProto();

    if (args.includes('--verify')) {
        await verifyMode();
        return;
    }

    if (args.includes('--decode')) {
        await decodeMode(args);
        return;
    }

    printHelp();
    process.exitCode = 1;
}

main().catch((err: any) => {
    console.error('PB 解码失败:', err && err.message ? err.message : err);
    process.exit(1);
});
