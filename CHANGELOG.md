# Changelog

## 1.0.2

- `coco_start` no longer types `WIDTH 40` when MAME boots.
- A failed disk mount leaves the disk that was already in the drive.
- `coco_load_state` errors right away if that save file is not there.
- Removed the `lowercase` result and the `trueLowercase` option added in 1.0.1.

## 1.0.1

- `coco_start` tried `WIDTH 40` after boot and reported whether that worked. Removed in 1.0.2.
- `coco_write_memory` rejects bad hex instead of writing whatever bytes it can pick out.
- A bad line from the MAME bridge is written to the log instead of being dropped.

## 1.0.0

- First version: start and stop MAME, type, mount disks, snapshot the screen, read and write memory, save and load state, and build a disk with `decb`.
