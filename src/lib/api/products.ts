import { invoke } from "@tauri-apps/api/core";
import { mergeProductVisibility, type ProductId, type ProductVisibilityState } from "../products";

interface ProductVisibilityRow {
  productId: ProductId;
  enabled: boolean;
}

export async function getProductVisibility(): Promise<ProductVisibilityState> {
  try {
    const rows = await invoke<ProductVisibilityRow[]>("get_product_visibility");
    return mergeProductVisibility(
      Object.fromEntries(
        rows.map(({ productId, enabled }) => [productId, enabled]),
      ) as Partial<ProductVisibilityState>,
    );
  } catch (error) {
    throw new Error(`Failed to load product visibility: ${error}`);
  }
}

export async function setProductVisibility(productId: ProductId, enabled: boolean): Promise<void> {
  try {
    await invoke("set_product_visibility", { productId, enabled });
  } catch (error) {
    throw new Error(`Failed to persist product visibility for ${productId}: ${error}`);
  }
}
