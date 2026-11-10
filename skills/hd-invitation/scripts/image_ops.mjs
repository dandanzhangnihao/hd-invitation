#!/usr/bin/env node
// 确定性图像组装；不生成文字、logo 或二维码，不把放大当成原生高清。
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const args = process.argv.slice(2);
let sharp;
try {
  const flag = args.indexOf('--sharp');
  if (flag >= 0) {
    const entry = args[flag + 1];
    if (!entry) throw new Error('--sharp 后需给 sharp 的模块入口');
    sharp = (await import(pathToFileURL(path.resolve(entry)).href)).default;
    args.splice(flag, 2);
  } else sharp = (await import('sharp')).default;
  if (args.length !== 1) throw new Error('用法: node image_ops.mjs 配置.json [--sharp /绝对路径/模块入口]');
  const configPath = path.resolve(args[0]);
  const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const resolve = value => path.resolve(path.dirname(configPath), value);
  const positive = v => Number.isInteger(v) && v > 0;
  const rect = r => r && Number.isInteger(r.left) && r.left >= 0 && Number.isInteger(r.top) && r.top >= 0 && positive(r.width) && positive(r.height);
  const meta = async file => {
    const m = await sharp(file).metadata();
    if (m.orientation && m.orientation !== 1) throw new Error('请先明确校正 EXIF 方向，再使用像素坐标');
    return {width:m.width, height:m.height, format:m.format, channels:m.channels};
  };
  const reserve = async file => {
    await fs.mkdir(path.dirname(file), {recursive:true});
    // 独占创建，防止覆盖已有原图、版本或报告。
    const handle = await fs.open(file, 'wx');
    await handle.close();
  };
  const save = async (pipeline, output) => {
    const data = await pipeline.png().toBuffer();
    await reserve(output);
    await fs.writeFile(output, data);
  };
  const diff = async (before, after, allowed) => {
    const a = await sharp(before).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const b = await sharp(after).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error('差异检查要求图片尺寸相同');
    if (!allowed.every(rect)) throw new Error('允许区域必须为有效整数矩形');
    let changedPixels = 0, outsideChangedPixels = 0;
    for (let y=0;y<a.info.height;y++) for(let x=0;x<a.info.width;x++) {
      const p=(y*a.info.width+x)*4;
      if ([0,1,2,3].some(c => a.data[p+c] !== b.data[p+c])) {
        changedPixels++;
        if (!allowed.some(r => x>=r.left && x<r.left+r.width && y>=r.top && y<r.top+r.height)) outsideChangedPixels++;
      }
    }
    return {changedPixels, outsideChangedPixels, pass:outsideChangedPixels===0};
  };
  let result;
  if (cfg.action === 'inspect') {
    result = await Promise.all(cfg.inputs.map(async p => ({file:resolve(p), ...await meta(resolve(p))})));
  } else if (cfg.action === 'crop') {
    if (!rect(cfg.region)) throw new Error('无效裁切区域');
    const output=resolve(cfg.output);
    await save(sharp(resolve(cfg.input)).extract(cfg.region), output);
    result={output,...await meta(output)};
  } else if (cfg.action === 'assemble') {
    if (!positive(cfg.width) || !positive(cfg.height) || !cfg.tiles?.length) throw new Error('需指定画布宽高和 tiles');
    const layers=[], provenance=[];
    let cursor=0;
    for (const tile of cfg.tiles) {
      if (tile.top !== cursor || !positive(tile.height)) throw new Error('拼接区域必须顺序连续，无缺口、重叠；请先在无字处选好裁切边界');
      const input=resolve(tile.input), m=await meta(input);
      let p=sharp(input), sw=m.width, sh=m.height;
      if (tile.crop) {
        if (!rect(tile.crop)) throw new Error('无效裁片区域');
        p=p.extract(tile.crop); sw=tile.crop.width; sh=tile.crop.height;
      }
      if (cfg.width>sw+1 || tile.height>sh+1) throw new Error('拒绝放大生成块凑高清尺寸；只允许至多 1 px 的取整差异');
      if (Math.abs((cfg.width/tile.height)/(sw/sh)-1) > 0.01) throw new Error('目标比例与原生裁片差异超过 1%，请重新选择裁切或画布尺寸');
      const data=await p.resize(cfg.width,tile.height,{fit:'fill'}).png().toBuffer();
      layers.push({input:data,left:0,top:tile.top});
      provenance.push({input,nativeWidth:m.width,nativeHeight:m.height,crop:tile.crop??null,outputWidth:cfg.width,outputHeight:tile.height,top:tile.top});
      cursor+=tile.height;
    }
    if(cursor!==cfg.height) throw new Error('分段总高度与画布不一致');
    const output=resolve(cfg.output);
    await save(sharp({create:{width:cfg.width,height:cfg.height,channels:4,background:'#ffffff'}}).composite(layers),output);
    result={output,...await meta(output),provenance};
  } else if (cfg.action === 'paste') {
    const box=cfg.box;
    if(!rect(box)) throw new Error('无效粘贴位置');
    const input=resolve(cfg.input),asset=resolve(cfg.asset),output=resolve(cfg.output);
    const m=await meta(input), a=await meta(asset);
    if(box.left+box.width>m.width || box.top+box.height>m.height) throw new Error('粘贴范围超出画布');
    if(cfg.kind==='qr' && (a.width!==a.height || box.width!==box.height)) throw new Error('二维码源图和目标框必须为正方形，禁止拉伸');
    const data=await sharp(asset).resize(box.width,box.height,{fit:'contain',kernel:cfg.kind==='qr'?'nearest':'lanczos3',background:cfg.kind==='qr'?'#ffffff':{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
    await save(sharp(input).composite([{input:data,left:box.left,top:box.top}]),output);
    result={output,...await meta(output),...await diff(input,output,[box]),qrDecodeStillRequired:cfg.kind==='qr'};
  } else if (cfg.action === 'compare') {
    result=await diff(resolve(cfg.before),resolve(cfg.after),cfg.allowed??[]);
  } else throw new Error('未知 action: inspect / crop / assemble / paste / compare');
  if(cfg.report) {
    const dest=resolve(cfg.report); await reserve(dest); await fs.writeFile(dest,JSON.stringify(result,null,2)+'\n');
  }
  console.log(JSON.stringify(result,null,2));
  if(result?.pass===false) process.exitCode=2;
} catch (error) {
  console.error(error.message);
  process.exitCode=1;
}
