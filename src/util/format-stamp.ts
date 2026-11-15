

/**
 * 时间戳(文件名用):20261002-151915
 * 用可读格式而不是毫秒数 - 导出一堆数据时便于一眼分辨先后
 */
export function formatStamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return (
        `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
        `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
}