/** 环形缓冲:容量固定,满了丢最旧的 */
export class RingBuffer<T> {
    //**缓冲存放处 */
    private _items: T[] = [];

    constructor(private bufferCapacity: number) { }

    /** 调整容量(配置实时生效用 缩小时立即裁掉多余的 )*/
    set capacity(n: number) {
        this.bufferCapacity = n;
        if (Number.isFinite(n) && this._items.length > n) {
            this._items.splice(0, this._items.length - n);
        }
    }

    get capacity(): number {
        return this.bufferCapacity;
    }

    /** 清空缓冲区*/
    clear(): void {
        this._items = [];
    }

    /** 添加一个项目到缓冲区*/
    add(item: T): void {
        if (this.bufferCapacity <= 0) return; // 容量 0 → 直接不收
        this._items.push(item);
        if (Number.isFinite(this.bufferCapacity) && this._items.length > this.bufferCapacity) {
            this._items.shift(); // 丢掉最旧的
        }
    }

    /** 快照(拷贝一份,避免外部修改内部数组) */
    get items(): T[] {
        return [...this._items];
    }
}