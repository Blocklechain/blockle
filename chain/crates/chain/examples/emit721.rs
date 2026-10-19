// Emit BLOCK-721 collection bytecode (hex) for a given name/symbol.
use blockle_chain::block721::block721_bytecode;
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).map(|s| s.as_str()).unwrap_or("World Items");
    let symbol = args.get(2).map(|s| s.as_str()).unwrap_or("WITEM");
    let code = block721_bytecode(name, symbol);
    println!("{}", hex::encode(code));
}
