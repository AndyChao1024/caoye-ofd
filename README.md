# 草叶 OFD 预览

纯前端的 OFD 版式预览组件。浏览器按 GB/T 33190 在本地解析并绘制，文件不会上传。

页面标签是 `<caoye-ofd>`。

```html
<caoye-ofd id="preview" style="height:100%"></caoye-ofd>
<script type="module">
  import "./caoye-ofd.js";

  document.querySelector("#preview").open("/archive/file/123.ofd");
</script>
```

`caoye-ofd.js` 和 `viewer.js` 放在同一目录。组件需要明确高度。档案系统的对接方式、文件流、档号章参数和打印说明见 [对接说明](对接说明.md)。

本地演示用静态站点打开 `demo.html`。演示页可以打开本地 OFD，在没有章的文件上补一枚示例档号章，并下载写进文件的 OFD。

## 功能

- 在浏览器里打开 OFD，绘制文字、图片、表格线和签章外观。文件不会上传。
- 打印时一页版式对应一张纸。同一文件里页面宽度不一致时，较窄的页面在纸张上水平居中。
- 文件没有档号章时，`setArchiveStamp({ rows })` 在指定页右上角补一枚。格子文字用黑体，外框和分隔线一样粗。这一页已经有章时不再叠加。
- `download()` 把这枚章写成注释层里的图片，生成一份新的 OFD。正在预览的原文件不会被改写。

## 协议

[MIT](LICENSE) © 2026 AndyChao
