// BASEショップの商品データを取得し、画像を正方形にリサイズしてHP用の静的データを生成するバッチスクリプト。
// GitHub Actionsの定期実行（1日1回）から呼び出される想定。API呼び出しやリサイズに失敗した場合は
// 既存の products.json / products/ 配下を上書きしないため、サイト側は直前の最新データを表示し続ける。

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const PRODUCTS_JSON_PATH = path.join(REPO_ROOT, "products.json");
const PRODUCTS_IMG_DIR = path.join(REPO_ROOT, "products");
// BASEのrefresh_tokenは使用のたびに新しいものへローテーションすることを実機確認済み。
// 新しいrefresh_tokenが発行された場合はこのファイルに書き出し、GitHub Actions側で
// gh secret set を使ってBASE_REFRESH_TOKENへ自動的に書き戻す。
const NEW_REFRESH_TOKEN_PATH = path.join(__dirname, ".new-refresh-token");

const CLIENT_ID = requireEnv("BASE_CLIENT_ID");
const CLIENT_SECRET = requireEnv("BASE_CLIENT_SECRET");
const REFRESH_TOKEN = requireEnv("BASE_REFRESH_TOKEN");
const SHOP_DOMAIN = requireEnv("BASE_SHOP_DOMAIN"); // 例: ascoral （ascoral.base.shop の ascoral 部分）

const IMAGE_SIZE = 800; // 正方形1辺のpx数
const ITEMS_PER_PAGE = 100;
const MAX_PAGES = 20; // 想定外の無限ループを避けるための安全上限（最大2000点まで対応）

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`環境変数 ${name} が設定されていません。処理を中止します。`);
    process.exit(1);
  }
  return value;
}

async function fetchAccessToken() {
  const res = await fetch("https://api.thebase.in/1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    throw new Error(`アクセストークンの取得に失敗しました (HTTP ${res.status}): ${await res.text()}`);
  }

  const data = await res.json();

  // BASEのrefresh_tokenは使用のたびに新しいものへローテーションする（実機確認済み）。
  // 新しいrefresh_tokenが発行された場合はファイルに書き出し、CI側でSecretsへ書き戻す。
  if (data.refresh_token && data.refresh_token !== REFRESH_TOKEN) {
    console.warn("[情報] BASEから新しいrefresh_tokenが発行されました。Secretsを自動更新します。");
    await fs.writeFile(NEW_REFRESH_TOKEN_PATH, data.refresh_token, "utf-8");
  }

  return data.access_token;
}

async function fetchAllItems(accessToken) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * ITEMS_PER_PAGE;
    const url = `https://api.thebase.in/1/items?limit=${ITEMS_PER_PAGE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error(`商品一覧の取得に失敗しました (HTTP ${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    const pageItems = data.items ?? [];
    items.push(...pageItems);

    if (pageItems.length < ITEMS_PER_PAGE) break; // 最終ページ
  }
  return items;
}

function resolveStock(item) {
  if (Array.isArray(item.variations) && item.variations.length > 0) {
    return item.variations.reduce((sum, v) => sum + Number(v.variation_stock ?? 0), 0);
  }
  return Number(item.stock ?? 0);
}

function primaryImageUrl(item) {
  for (let i = 1; i <= 5; i++) {
    const url = item[`img${i}_origin`];
    if (url) return url;
  }
  return null;
}

async function downloadAndCropSquare(imageUrl, destPath) {
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`画像のダウンロードに失敗しました (HTTP ${res.status}): ${imageUrl}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  await sharp(buffer)
    .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: "cover", position: "centre" })
    .jpeg({ quality: 82 })
    .toFile(destPath);
}

async function main() {
  console.log("BASE商品データの取得を開始します。");

  const accessToken = await fetchAccessToken();
  const rawItems = await fetchAllItems(accessToken);
  console.log(`BASEから${rawItems.length}件の商品を取得しました。`);

  await fs.mkdir(PRODUCTS_IMG_DIR, { recursive: true });

  const products = [];

  for (const item of rawItems) {
    try {
      // visible=0（非表示設定）と、在庫切れの商品は一覧から除外する。
      if (Number(item.visible) === 0) continue;
      const stock = resolveStock(item);
      if (stock <= 0) continue;

      const imageUrl = primaryImageUrl(item);
      const imageFileName = `${item.item_id}.jpg`;
      const imageDestPath = path.join(PRODUCTS_IMG_DIR, imageFileName);

      if (imageUrl) {
        await downloadAndCropSquare(imageUrl, imageDestPath);
      } else {
        console.warn(`[警告] 商品 ${item.item_id}(${item.title}) に画像がありません。No Image画像を使用します。`);
      }

      products.push({
        id: item.item_id,
        title: item.title,
        price: Number(item.price),
        image: imageUrl ? `products/${imageFileName}` : "products/no-image.svg",
        url: `https://${SHOP_DOMAIN}.base.shop/items/${item.item_id}`,
        listOrder: Number(item.list_order ?? 0),
      });
    } catch (err) {
      // 1商品の処理失敗でバッチ全体を止めない。当該商品はスキップして続行する。
      console.error(`[エラー] 商品 ${item.item_id} の処理に失敗したためスキップします:`, err.message);
    }
  }

  products.sort((a, b) => a.listOrder - b.listOrder);

  await fs.writeFile(
    PRODUCTS_JSON_PATH,
    JSON.stringify({ updatedAt: new Date().toISOString(), products }, null, 2),
    "utf-8"
  );

  console.log(`products.json を書き出しました（掲載商品数: ${products.length}件）。`);
}

main().catch((err) => {
  // ここで失敗した場合、products.json / products/ は上書きされていないため、
  // サイトには直前の最新データが表示され続ける。
  console.error("BASE商品データの更新に失敗しました:", err);
  process.exit(1);
});
