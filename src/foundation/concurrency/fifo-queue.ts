export interface QueueNode<T> {
  next: QueueNode<T> | undefined;
  previous: QueueNode<T> | undefined;
  queued: boolean;
  readonly value: T;
}

/** 内部双向队列，使 FIFO 出队和取消任意等待项都保持 O(1)。 */
export class FifoQueue<T> {
  private head: QueueNode<T> | undefined;
  private length = 0;
  private tail: QueueNode<T> | undefined;

  get size(): number {
    return this.length;
  }

  enqueue(value: T): QueueNode<T> {
    const node: QueueNode<T> = {
      next: undefined,
      previous: this.tail,
      queued: true,
      value,
    };

    if (this.tail === undefined) {
      this.head = node;
    } else {
      this.tail.next = node;
    }

    this.tail = node;
    this.length += 1;
    return node;
  }

  dequeue(): T | undefined {
    const node = this.head;
    if (node === undefined) {
      return undefined;
    }

    this.detach(node);
    return node.value;
  }

  remove(node: QueueNode<T>): boolean {
    if (!node.queued) {
      return false;
    }

    this.detach(node);
    return true;
  }

  private detach(node: QueueNode<T>): void {
    if (node.previous === undefined) {
      this.head = node.next;
    } else {
      node.previous.next = node.next;
    }

    if (node.next === undefined) {
      this.tail = node.previous;
    } else {
      node.next.previous = node.previous;
    }

    node.next = undefined;
    node.previous = undefined;
    node.queued = false;
    this.length -= 1;
  }
}
