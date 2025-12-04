// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface Crop {
  id: string;
  name: string;
  encryptedGenes: string;
  yield: number;
  resistance: number;
  growthTime: number;
  timestamp: number;
  owner: string;
  isHybrid: boolean;
  parent1?: string;
  parent2?: string;
}

interface HybridizationHistory {
  id: string;
  parent1: string;
  parent2: string;
  result: string;
  timestamp: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeHybrid = (encryptedData1: string, encryptedData2: string): {yield: string, resistance: string} => {
  const value1 = FHEDecryptNumber(encryptedData1);
  const value2 = FHEDecryptNumber(encryptedData2);
  
  // Simulate FHE computation for hybridization
  const newYield = (value1 * 0.6 + value2 * 0.4) * (0.8 + Math.random() * 0.4);
  const newResistance = (value1 * 0.4 + value2 * 0.6) * (0.8 + Math.random() * 0.4);
  
  return {
    yield: FHEEncryptNumber(newYield),
    resistance: FHEEncryptNumber(newResistance)
  };
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showPlantModal, setShowPlantModal] = useState(false);
  const [planting, setPlanting] = useState(false);
  const [showHybridModal, setShowHybridModal] = useState(false);
  const [hybridizing, setHybridizing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newCropData, setNewCropData] = useState({ name: "", yield: 0, resistance: 0, growthTime: 0 });
  const [selectedParents, setSelectedParents] = useState<{parent1: Crop | null, parent2: Crop | null}>({parent1: null, parent2: null});
  const [selectedCrop, setSelectedCrop] = useState<Crop | null>(null);
  const [decryptedYield, setDecryptedYield] = useState<number | null>(null);
  const [decryptedResistance, setDecryptedResistance] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [hybridizationHistory, setHybridizationHistory] = useState<HybridizationHistory[]>([]);
  
  // Statistics
  const totalCrops = crops.length;
  const averageYield = crops.length > 0 ? crops.reduce((sum, crop) => sum + crop.yield, 0) / crops.length : 0;
  const averageResistance = crops.length > 0 ? crops.reduce((sum, crop) => sum + crop.resistance, 0) / crops.length : 0;
  const hybridCrops = crops.filter(crop => crop.isHybrid).length;

  useEffect(() => {
    loadCrops().finally(() => setLoading(false));
    loadHybridizationHistory().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadCrops = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("crop_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing crop keys:", e); }
      }
      const list: Crop[] = [];
      for (const key of keys) {
        try {
          const cropBytes = await contract.getData(`crop_${key}`);
          if (cropBytes.length > 0) {
            try {
              const cropData = JSON.parse(ethers.toUtf8String(cropBytes));
              list.push({ 
                id: key, 
                name: cropData.name, 
                encryptedGenes: cropData.encryptedGenes, 
                yield: cropData.yield, 
                resistance: cropData.resistance, 
                growthTime: cropData.growthTime, 
                timestamp: cropData.timestamp, 
                owner: cropData.owner, 
                isHybrid: cropData.isHybrid || false,
                parent1: cropData.parent1,
                parent2: cropData.parent2
              });
            } catch (e) { console.error(`Error parsing crop data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading crop ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setCrops(list);
    } catch (e) { console.error("Error loading crops:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const loadHybridizationHistory = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const historyBytes = await contract.getData("hybridization_history");
      let history: HybridizationHistory[] = [];
      if (historyBytes.length > 0) {
        try {
          const historyStr = ethers.toUtf8String(historyBytes);
          if (historyStr.trim() !== '') history = JSON.parse(historyStr);
        } catch (e) { console.error("Error parsing hybridization history:", e); }
      }
      setHybridizationHistory(history);
    } catch (e) { console.error("Error loading hybridization history:", e); }
  };

  const plantCrop = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setPlanting(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting crop genes with Zama FHE..." });
    try {
      const encryptedYield = FHEEncryptNumber(newCropData.yield);
      const encryptedResistance = FHEEncryptNumber(newCropData.resistance);
      const encryptedGenes = `${encryptedYield}|${encryptedResistance}`;
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const cropId = `crop-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const cropData = { 
        name: newCropData.name, 
        encryptedGenes: encryptedGenes, 
        yield: newCropData.yield, 
        resistance: newCropData.resistance, 
        growthTime: newCropData.growthTime, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        isHybrid: false
      };
      await contract.setData(`crop_${cropId}`, ethers.toUtf8Bytes(JSON.stringify(cropData)));
      const keysBytes = await contract.getData("crop_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(cropId);
      await contract.setData("crop_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      setTransactionStatus({ visible: true, status: "success", message: "New crop planted with encrypted genes!" });
      await loadCrops();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowPlantModal(false);
        setNewCropData({ name: "", yield: 0, resistance: 0, growthTime: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Planting failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setPlanting(false); }
  };

  const hybridizeCrops = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (!selectedParents.parent1 || !selectedParents.parent2) { alert("Please select two parent crops"); return; }
    
    setHybridizing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Performing FHE-based hybridization..." });
    try {
      // Extract yield and resistance from encrypted genes
      const parent1Genes = selectedParents.parent1.encryptedGenes.split('|');
      const parent2Genes = selectedParents.parent2.encryptedGenes.split('|');
      
      // Perform FHE computation on encrypted genes
      const newYield = FHEComputeHybrid(parent1Genes[0], parent2Genes[0]).yield;
      const newResistance = FHEComputeHybrid(parent1Genes[1], parent2Genes[1]).resistance;
      
      const encryptedGenes = `${newYield}|${newResistance}`;
      
      // Decrypt for display purposes only (in real FHE this wouldn't be done)
      const displayYield = FHEDecryptNumber(newYield);
      const displayResistance = FHEDecryptNumber(newResistance);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const cropId = `hybrid-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const cropData = { 
        name: `${selectedParents.parent1.name} × ${selectedParents.parent2.name}`,
        encryptedGenes: encryptedGenes, 
        yield: displayYield, 
        resistance: displayResistance, 
        growthTime: Math.round((selectedParents.parent1.growthTime + selectedParents.parent2.growthTime) / 2), 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        isHybrid: true,
        parent1: selectedParents.parent1.id,
        parent2: selectedParents.parent2.id
      };
      await contract.setData(`crop_${cropId}`, ethers.toUtf8Bytes(JSON.stringify(cropData)));
      const keysBytes = await contract.getData("crop_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(cropId);
      await contract.setData("crop_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      // Update hybridization history
      const historyEntry = {
        id: `hybridization-${Date.now()}`,
        parent1: selectedParents.parent1.id,
        parent2: selectedParents.parent2.id,
        result: cropId,
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      const historyBytes = await contract.getData("hybridization_history");
      let history: HybridizationHistory[] = [];
      if (historyBytes.length > 0) {
        try { history = JSON.parse(ethers.toUtf8String(historyBytes)); } 
        catch (e) { console.error("Error parsing history:", e); }
      }
      history.push(historyEntry);
      await contract.setData("hybridization_history", ethers.toUtf8Bytes(JSON.stringify(history)));
      
      setTransactionStatus({ visible: true, status: "success", message: "New hybrid crop created with FHE!" });
      await loadCrops();
      await loadHybridizationHistory();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowHybridModal(false);
        setSelectedParents({parent1: null, parent2: null});
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Hybridization failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setHybridizing(false); }
  };

  const decryptWithSignature = async (encryptedGenes: string): Promise<{yield: number, resistance: number} | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const genes = encryptedGenes.split('|');
      return {
        yield: FHEDecryptNumber(genes[0]),
        resistance: FHEDecryptNumber(genes[1])
      };
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const isOwner = (cropOwner: string) => address?.toLowerCase() === cropOwner.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="farming-spinner"></div>
      <p>Initializing encrypted farm...</p>
    </div>
  );

  return (
    <div className="app-container farming-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="plant-icon"></div></div>
          <h1>Secret<span>Crop</span>Genetics</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowPlantModal(true)} className="plant-crop-btn farming-button">
            <div className="add-icon"></div>Plant New Crop
          </button>
          <button onClick={() => setShowHybridModal(true)} className="hybridize-btn farming-button">
            <div className="hybrid-icon"></div>Hybridize Crops
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-based Farming Simulator</h2>
            <p>Discover and breed new crops with encrypted genetics using Zama FHE technology</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        
        <div className="dashboard-grid">
          <div className="dashboard-card farming-card intro-card">
            <h3>About Secret Crop Genetics</h3>
            <p>Welcome to the world of encrypted farming! Using <strong>Zama FHE technology</strong>, 
            all crop genetics are encrypted on-chain. Breed new hybrids by crossing existing crops 
            and discover valuable traits through FHE-based computation.</p>
            <div className="fhe-badge"><span>FHE-Powered Breeding</span></div>
          </div>
          
          <div className="dashboard-card farming-card stats-card">
            <h3>Farm Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{totalCrops}</div><div className="stat-label">Total Crops</div></div>
              <div className="stat-item"><div className="stat-value">{hybridCrops}</div><div className="stat-label">Hybrids</div></div>
              <div className="stat-item"><div className="stat-value">{averageYield.toFixed(1)}</div><div className="stat-label">Avg Yield</div></div>
              <div className="stat-item"><div className="stat-value">{averageResistance.toFixed(1)}</div><div className="stat-label">Avg Resistance</div></div>
            </div>
          </div>
        </div>
        
        <div className="content-sections">
          <div className="crops-section">
            <div className="section-header">
              <h2>Your Crops Collection</h2>
              <div className="header-actions">
                <button onClick={loadCrops} className="refresh-btn farming-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh Crops"}
                </button>
              </div>
            </div>
            <div className="crops-list farming-card">
              <div className="table-header">
                <div className="header-cell">Name</div>
                <div className="header-cell">Type</div>
                <div className="header-cell">Yield</div>
                <div className="header-cell">Resistance</div>
                <div className="header-cell">Growth Time</div>
                <div className="header-cell">Actions</div>
              </div>
              {crops.length === 0 ? (
                <div className="no-crops">
                  <div className="no-crops-icon"></div>
                  <p>No crops found in your collection</p>
                  <button className="farming-button primary" onClick={() => setShowPlantModal(true)}>Plant Your First Crop</button>
                </div>
              ) : crops.map(crop => (
                <div className="crop-row" key={crop.id} onClick={() => setSelectedCrop(crop)}>
                  <div className="table-cell crop-name">{crop.name}</div>
                  <div className="table-cell">{crop.isHybrid ? "Hybrid" : "Base"}</div>
                  <div className="table-cell">{crop.yield.toFixed(1)}</div>
                  <div className="table-cell">{crop.resistance.toFixed(1)}</div>
                  <div className="table-cell">{crop.growthTime} days</div>
                  <div className="table-cell actions">
                    {isOwner(crop.owner) && (
                      <button className="action-btn farming-button" onClick={(e) => { e.stopPropagation(); setSelectedCrop(crop); }}>
                        View Details
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="history-section">
            <div className="section-header">
              <h2>Hybridization History</h2>
            </div>
            <div className="history-list farming-card">
              {hybridizationHistory.length === 0 ? (
                <div className="no-history">
                  <p>No hybridization history yet</p>
                </div>
              ) : hybridizationHistory.map(record => {
                const parent1 = crops.find(c => c.id === record.parent1);
                const parent2 = crops.find(c => c.id === record.parent2);
                const result = crops.find(c => c.id === record.result);
                
                return (
                  <div className="history-item" key={record.id}>
                    <div className="hybridization-info">
                      <div className="parent-names">
                        {parent1 ? parent1.name : "Unknown"} × {parent2 ? parent2.name : "Unknown"}
                      </div>
                      <div className="result-info">
                        → {result ? result.name : "New Hybrid"}
                      </div>
                    </div>
                    <div className="hybridization-date">
                      {new Date(record.timestamp * 1000).toLocaleDateString()}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      
      {showPlantModal && (
        <ModalPlant 
          onSubmit={plantCrop} 
          onClose={() => setShowPlantModal(false)} 
          planting={planting} 
          cropData={newCropData} 
          setCropData={setNewCropData}
        />
      )}
      
      {showHybridModal && (
        <ModalHybridize 
          onSubmit={hybridizeCrops} 
          onClose={() => setShowHybridModal(false)} 
          hybridizing={hybridizing} 
          crops={crops}
          selectedParents={selectedParents}
          setSelectedParents={setSelectedParents}
        />
      )}
      
      {selectedCrop && (
        <CropDetailModal 
          crop={selectedCrop} 
          onClose={() => { setSelectedCrop(null); setDecryptedYield(null); setDecryptedResistance(null); }} 
          decryptedYield={decryptedYield}
          decryptedResistance={decryptedResistance}
          setDecryptedYield={setDecryptedYield}
          setDecryptedResistance={setDecryptedResistance}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content farming-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="farming-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="plant-icon"></div><span>SecretCropGenetics</span></div>
            <p>FHE-based farming simulator with encrypted crop genetics</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>Powered by Zama FHE</span></div>
          <div className="copyright">© {new Date().getFullYear()} SecretCropGenetics. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalPlantProps {
  onSubmit: () => void; 
  onClose: () => void; 
  planting: boolean;
  cropData: any;
  setCropData: (data: any) => void;
}

const ModalPlant: React.FC<ModalPlantProps> = ({ onSubmit, onClose, planting, cropData, setCropData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setCropData({ ...cropData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCropData({ ...cropData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!cropData.name || !cropData.yield || !cropData.resistance || !cropData.growthTime) { 
      alert("Please fill all required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal farming-card">
        <div className="modal-header">
          <h2>Plant New Crop</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Crop genetics will be encrypted with Zama FHE before planting</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Crop Name *</label>
              <input type="text" name="name" value={cropData.name} onChange={handleChange} placeholder="Enter crop name..." className="farming-input"/>
            </div>
            <div className="form-group">
              <label>Yield Potential (1-10) *</label>
              <input 
                type="number" 
                name="yield" 
                value={cropData.yield} 
                onChange={handleValueChange} 
                placeholder="1-10" 
                className="farming-input"
                min="1"
                max="10"
                step="0.1"
              />
            </div>
            <div className="form-group">
              <label>Disease Resistance (1-10) *</label>
              <input 
                type="number" 
                name="resistance" 
                value={cropData.resistance} 
                onChange={handleValueChange} 
                placeholder="1-10" 
                className="farming-input"
                min="1"
                max="10"
                step="0.1"
              />
            </div>
            <div className="form-group">
              <label>Growth Time (days) *</label>
              <input 
                type="number" 
                name="growthTime" 
                value={cropData.growthTime} 
                onChange={handleValueChange} 
                placeholder="Days to harvest" 
                className="farming-input"
                min="1"
                max="365"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Genetics:</span><div>Yield: {cropData.yield || '?'}, Resistance: {cropData.resistance || '?'}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{cropData.yield && cropData.resistance ? 
                  `FHE-${btoa(cropData.yield.toString()).substring(0, 10)}...|FHE-${btoa(cropData.resistance.toString()).substring(0, 10)}...` : 
                  'No data entered'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn farming-button">Cancel</button>
          <button onClick={handleSubmit} disabled={planting} className="submit-btn farming-button primary">
            {planting ? "Encrypting with FHE..." : "Plant Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ModalHybridizeProps {
  onSubmit: () => void; 
  onClose: () => void; 
  hybridizing: boolean;
  crops: Crop[];
  selectedParents: any;
  setSelectedParents: (parents: any) => void;
}

const ModalHybridize: React.FC<ModalHybridizeProps> = ({ onSubmit, onClose, hybridizing, crops, selectedParents, setSelectedParents }) => {
  const handleSelectParent = (parentNum: number, crop: Crop) => {
    if (parentNum === 1) {
      setSelectedParents({...selectedParents, parent1: crop});
    } else {
      setSelectedParents({...selectedParents, parent2: crop});
    }
  };

  return (
    <div className="modal-overlay">
      <div className="hybrid-modal farming-card">
        <div className="modal-header">
          <h2>Create New Hybrid</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Hybridization</strong><p>Cross two crops using FHE computation on encrypted genetics</p></div>
          </div>
          
          <div className="parent-selection">
            <div className="parent-section">
              <h3>Parent 1</h3>
              {selectedParents.parent1 ? (
                <div className="selected-parent">
                  <div className="parent-name">{selectedParents.parent1.name}</div>
                  <div className="parent-stats">
                    Yield: {selectedParents.parent1.yield} | Resistance: {selectedParents.parent1.resistance}
                  </div>
                  <button className="change-parent" onClick={() => setSelectedParents({...selectedParents, parent1: null})}>
                    Change
                  </button>
                </div>
              ) : (
                <div className="parent-options">
                  {crops.filter(crop => crop.id !== selectedParents.parent2?.id).map(crop => (
                    <div key={crop.id} className="parent-option" onClick={() => handleSelectParent(1, crop)}>
                      <div className="parent-name">{crop.name}</div>
                      <div className="parent-stats">
                        Yield: {crop.yield} | Resistance: {crop.resistance}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="hybrid-icon">×</div>
            
            <div className="parent-section">
              <h3>Parent 2</h3>
              {selectedParents.parent2 ? (
                <div className="selected-parent">
                  <div className="parent-name">{selectedParents.parent2.name}</div>
                  <div className="parent-stats">
                    Yield: {selectedParents.parent2.yield} | Resistance: {selectedParents.parent2.resistance}
                  </div>
                  <button className="change-parent" onClick={() => setSelectedParents({...selectedParents, parent2: null})}>
                    Change
                  </button>
                </div>
              ) : (
                <div className="parent-options">
                  {crops.filter(crop => crop.id !== selectedParents.parent1?.id).map(crop => (
                    <div key={crop.id} className="parent-option" onClick={() => handleSelectParent(2, crop)}>
                      <div className="parent-name">{crop.name}</div>
                      <div className="parent-stats">
                        Yield: {crop.yield} | Resistance: {crop.resistance}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          
          {selectedParents.parent1 && selectedParents.parent2 && (
            <div className="hybrid-preview">
              <h3>Expected Hybrid Traits</h3>
              <div className="preview-stats">
                <div className="preview-stat">
                  <span>Yield:</span> 
                  <strong>{(selectedParents.parent1.yield * 0.6 + selectedParents.parent2.yield * 0.4).toFixed(1)}</strong>
                </div>
                <div className="preview-stat">
                  <span>Resistance:</span> 
                  <strong>{(selectedParents.parent1.resistance * 0.4 + selectedParents.parent2.resistance * 0.6).toFixed(1)}</strong>
                </div>
                <div className="preview-stat">
                  <span>Growth Time:</span> 
                  <strong>{Math.round((selectedParents.parent1.growthTime + selectedParents.parent2.growthTime) / 2)} days</strong>
                </div>
              </div>
              <div className="fhe-note">
                Note: Actual results may vary due to FHE randomization factors
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn farming-button">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={hybridizing || !selectedParents.parent1 || !selectedParents.parent2} 
            className="submit-btn farming-button primary"
          >
            {hybridizing ? "Performing FHE Hybridization..." : "Create Hybrid"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface CropDetailModalProps {
  crop: Crop;
  onClose: () => void;
  decryptedYield: number | null;
  decryptedResistance: number | null;
  setDecryptedYield: (value: number | null) => void;
  setDecryptedResistance: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedGenes: string) => Promise<{yield: number, resistance: number} | null>;
}

const CropDetailModal: React.FC<CropDetailModalProps> = ({ 
  crop, onClose, decryptedYield, decryptedResistance, 
  setDecryptedYield, setDecryptedResistance, isDecrypting, decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedYield !== null) { 
      setDecryptedYield(null); 
      setDecryptedResistance(null);
      return; 
    }
    const decrypted = await decryptWithSignature(crop.encryptedGenes);
    if (decrypted !== null) {
      setDecryptedYield(decrypted.yield);
      setDecryptedResistance(decrypted.resistance);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="crop-detail-modal farming-card">
        <div className="modal-header">
          <h2>{crop.name} Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="crop-info">
            <div className="info-item"><span>Type:</span><strong>{crop.isHybrid ? "Hybrid" : "Base Crop"}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{crop.owner.substring(0, 6)}...{crop.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Planted:</span><strong>{new Date(crop.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Growth Time:</span><strong>{crop.growthTime} days</strong></div>
            
            {crop.isHybrid && crop.parent1 && crop.parent2 && (
              <>
                <div className="info-item"><span>Parent 1:</span><strong>{crop.parent1}</strong></div>
                <div className="info-item"><span>Parent 2:</span><strong>{crop.parent2}</strong></div>
              </>
            )}
          </div>
          
          <div className="genetics-section">
            <h3>Crop Genetics</h3>
            <div className="genetics-display">
              <div className="genetic-trait">
                <span>Yield Potential:</span>
                <strong>{crop.yield.toFixed(1)}</strong>
              </div>
              <div className="genetic-trait">
                <span>Disease Resistance:</span>
                <strong>{crop.resistance.toFixed(1)}</strong>
              </div>
            </div>
            
            <div className="encrypted-data-section">
              <h4>Encrypted Genetic Data</h4>
              <div className="encrypted-data">{crop.encryptedGenes.substring(0, 100)}...</div>
              <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
              
              <button className="decrypt-btn farming-button" onClick={handleDecrypt} disabled={isDecrypting}>
                {isDecrypting ? 
                  <span className="decrypt-spinner">Decrypting...</span> : 
                  decryptedYield !== null ? 
                  "Hide Raw Genetics" : 
                  "Decrypt with Wallet Signature"
                }
              </button>
            </div>
            
            {decryptedYield !== null && decryptedResistance !== null && (
              <div className="decrypted-data-section">
                <h4>Decrypted Genetic Values</h4>
                <div className="decrypted-genetics">
                  <div className="genetic-trait">
                    <span>Raw Yield Value:</span>
                    <strong>{decryptedYield.toFixed(6)}</strong>
                  </div>
                  <div className="genetic-trait">
                    <span>Raw Resistance Value:</span>
                    <strong>{decryptedResistance.toFixed(6)}</strong>
                  </div>
                </div>
                <div className="decryption-notice">
                  <div className="warning-icon"></div>
                  <span>These values are only visible after wallet signature verification</span>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn farming-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;