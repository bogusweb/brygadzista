import * as ImagePicker from "expo-image-picker";
import { Alert, Platform } from "react-native";
import type { PickedPhoto } from "./PinsProvider";

const OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  // Phones take 12+ MP; the server keeps 2560 px anyway, so a lighter file uploads faster on a weak signal.
  quality: 0.7,
  exif: false,
  // iOS hands out HEIC otherwise, which the server cannot read.
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

export const notify = (title: string, message: string) => {
  if (Platform.OS === "web") globalThis.alert?.(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

export const confirm = (title: string, message: string, action: string): Promise<boolean> => {
  if (Platform.OS === "web") return Promise.resolve(globalThis.confirm?.(`${title}\n\n${message}`) ?? false);
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Anuluj", style: "cancel", onPress: () => resolve(false) },
      { text: action, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
};

const toPicked = (result: ImagePicker.ImagePickerResult): PickedPhoto[] => {
  if (result.canceled) return [];
  const takenAt = new Date().toISOString();
  return result.assets.filter((asset) => asset.type !== "video").map((asset) => ({ uri: asset.uri, takenAt }));
};

export const takePhoto = async (): Promise<PickedPhoto[]> => {
  if (Platform.OS !== "web") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      notify("Brak dostępu do aparatu", "Zezwól Brygadziście na aparat w ustawieniach telefonu albo wybierz zdjęcie z galerii.");
      return [];
    }
  }
  return toPicked(await ImagePicker.launchCameraAsync(OPTIONS));
};

export const choosePhotos = async (): Promise<PickedPhoto[]> =>
  toPicked(await ImagePicker.launchImageLibraryAsync({ ...OPTIONS, allowsMultipleSelection: true, selectionLimit: 10 }));
