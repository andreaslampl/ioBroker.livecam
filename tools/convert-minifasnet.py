#!/usr/bin/env python3
# Builds models/face_live_v2.onnx and face_live_v1se.onnx from the MiniFASNet weights of
# https://github.com/minivision-ai/Silent-Face-Anti-Spoofing (Apache-2.0, resources/anti_spoof_models/*.pth)
# without PyTorch: reads the (legacy or zip) torch file with pickle + numpy and writes the same network with onnx.helper.
# Usage: python3 tools/convert-minifasnet.py 2.7_80x80_MiniFASNetV2.pth models/face_live_v2.onnx \
#        4_0_0_80x80_MiniFASNetV1SE.pth models/face_live_v1se.onnx   (needs numpy + onnx)
"""MiniFASNet .pth (Silent-Face-Anti-Spoofing, Apache-2.0) -> ONNX without torch."""
import sys, zipfile, pickle, collections
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

def load_legacy(path):
    """torch.save before 1.6: magic, protocol, sys info, pickle with persistent ids, storage keys, raw storages"""
    import struct, io
    f = open(path, 'rb')
    pickle.load(f); pickle.load(f); pickle.load(f)
    dtypes = {'FloatStorage': np.float32, 'LongStorage': np.int64, 'IntStorage': np.int32, 'HalfStorage': np.float16}
    storages = {}
    class StorageType:
        def __init__(self, name): self.name = name
    class Lazy:
        def __init__(self, key, dtype): self.key, self.dtype = key, dtype
    tensors = []
    def rebuild(storage, offset, size, stride, *a):
        t = {'storage': storage, 'offset': offset, 'size': tuple(size), 'stride': tuple(stride)}
        tensors.append(t)
        return t
    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == 'torch._utils' and name in ('_rebuild_tensor_v2', '_rebuild_tensor'):
                return rebuild
            if mod == 'torch' and name.endswith('Storage'):
                return StorageType(name)
            if mod == 'collections' and name == 'OrderedDict':
                return collections.OrderedDict
            if mod == 'torch._utils' and name == '_rebuild_parameter':
                return lambda data, *a: data
            raise pickle.UnpicklingError(f'{mod}.{name}')
        def persistent_load(self, pid):
            typename, st, key = pid[0], pid[1], pid[2]
            if key not in storages:
                storages[key] = Lazy(key, dtypes[st.name])
            return storages[key]
    sd = U(f).load()
    keys = pickle.load(f)
    data = {}
    for key in keys:
        n = struct.unpack('<q', f.read(8))[0]
        dt = storages[key].dtype
        data[key] = np.frombuffer(f.read(n * np.dtype(dt).itemsize), dtype=dt)
    out = collections.OrderedDict()
    for k, t in sd.items():
        arr = data[t['storage'].key]
        it = arr.itemsize
        v = np.lib.stride_tricks.as_strided(arr[t['offset']:], shape=t['size'], strides=tuple(s * it for s in t['stride'])).copy() if t['size'] else arr[t['offset']:t['offset'] + 1].reshape(())
        out[k[7:] if k.startswith('module.') else k] = v
    return out

def load_pth(path):
    if not zipfile.is_zipfile(path):
        return load_legacy(path)
    z = zipfile.ZipFile(path)
    names = z.namelist()
    root = names[0].split('/')[0]
    dtypes = {'FloatStorage': np.float32, 'LongStorage': np.int64, 'IntStorage': np.int32, 'HalfStorage': np.float16}
    class StorageType:
        def __init__(self, name): self.name = name
    def rebuild(storage, offset, size, stride, *a):
        arr = storage
        if not size:
            return arr[offset:offset + 1].reshape(())
        itemsize = arr.itemsize
        return np.lib.stride_tricks.as_strided(arr[offset:], shape=tuple(size), strides=tuple(s * itemsize for s in stride)).copy()
    class U(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == 'torch._utils' and name == '_rebuild_tensor_v2':
                return rebuild
            if mod == 'torch' and name.endswith('Storage'):
                return StorageType(name)
            if mod == 'collections' and name == 'OrderedDict':
                return collections.OrderedDict
            if mod == 'torch._utils' and name == '_rebuild_parameter':
                return lambda data, *a: data
            raise pickle.UnpicklingError(f'{mod}.{name}')
        def persistent_load(self, pid):
            _, st, key, loc, n = pid
            raw = z.read(f'{root}/data/{key}')
            return np.frombuffer(raw, dtype=dtypes[st.name])
    sd = U(z.open(f'{root}/data.pkl')).load()
    return collections.OrderedDict((k[7:] if k.startswith('module.') else k, v) for k, v in sd.items())

class G:
    def __init__(self, sd):
        self.sd, self.nodes, self.inits, self.n = sd, [], [], 0
    def w(self, key, arr=None):
        arr = self.sd[key] if arr is None else arr
        name = key
        if not any(i.name == name for i in self.inits):
            self.inits.append(numpy_helper.from_array(np.asarray(arr, dtype=np.float32), name))
        return name
    def out(self):
        self.n += 1
        return f't{self.n}'
    def node(self, op, ins, **kw):
        o = self.out()
        self.nodes.append(helper.make_node(op, ins, [o], **kw))
        return o
    def conv(self, x, key, stride, pad, cin):
        W = self.sd[key]
        groups = cin // W.shape[1]
        k = W.shape[2:]
        return self.node('Conv', [x, self.w(key)], strides=[stride, stride], pads=[pad, pad, pad, pad], group=groups, kernel_shape=list(k)), W.shape[0]
    def bn(self, x, p):
        return self.node('BatchNormalization', [x, self.w(p + '.weight'), self.w(p + '.bias'), self.w(p + '.running_mean'), self.w(p + '.running_var')], epsilon=1e-5)
    def prelu(self, x, p):
        a = self.sd[p + '.weight']
        return self.node('PRelu', [x, self.w(p + '.weight', a.reshape(-1, 1, 1))])
    def conv_block(self, x, p, cin, stride=1, pad=0):
        x, c = self.conv(x, p + '.conv.weight', stride, pad, cin)
        return self.prelu(self.bn(x, p + '.bn'), p + '.prelu'), c
    def linear_block(self, x, p, cin, stride=1, pad=0):
        x, c = self.conv(x, p + '.conv.weight', stride, pad, cin)
        return self.bn(x, p + '.bn'), c
    def se(self, x, p, c):
        y = self.node('GlobalAveragePool', [x])
        y, c1 = self.conv(y, p + '.fc1.weight', 1, 0, c)
        y = self.node('Relu', [self.bn(y, p + '.bn1')])
        y, _ = self.conv(y, p + '.fc2.weight', 1, 0, c1)
        y = self.node('Sigmoid', [self.bn(y, p + '.bn2')])
        return self.node('Mul', [x, y])
    def depth_wise(self, x, p, cin, stride, residual):
        y, c = self.conv_block(x, p + '.conv', cin)
        y, c = self.conv_block(y, p + '.conv_dw', c, stride, 1)
        y, c = self.linear_block(y, p + '.project', c)
        if residual:
            if (p + '.se_module.fc1.weight') in self.sd:
                y = self.se(y, p + '.se_module', c)
            y = self.node('Add', [x, y])
        return y, c
    def residual(self, x, p, c):
        i = 0
        while f'{p}.model.{i}.conv.conv.weight' in self.sd:
            x, c = self.depth_wise(x, f'{p}.model.{i}', c, 1, True)
            i += 1
        return x, c

def build(sd, size=80):
    g = G(sd)
    x, c = g.conv_block('input', 'conv1', 3, 2, 1)
    x, c = g.conv_block(x, 'conv2_dw', c, 1, 1)
    x, c = g.depth_wise(x, 'conv_23', c, 2, False)
    x, c = g.residual(x, 'conv_3', c)
    x, c = g.depth_wise(x, 'conv_34', c, 2, False)
    x, c = g.residual(x, 'conv_4', c)
    x, c = g.depth_wise(x, 'conv_45', c, 2, False)
    x, c = g.residual(x, 'conv_5', c)
    x, c = g.conv_block(x, 'conv_6_sep', c)
    x, c = g.linear_block(x, 'conv_6_dw', c)
    x = g.node('Flatten', [x], axis=1)
    if 'linear.weight' in sd:
        x = g.node('MatMul', [x, g.w('linear.weight', sd['linear.weight'].T)])
    x = g.bn(x, 'bn')
    x = g.node('MatMul', [x, g.w('prob.weight', sd['prob.weight'].T)])
    g.nodes[-1].output[0] = 'output'
    graph = helper.make_graph(g.nodes, 'MiniFASNet',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, size, size])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3])], g.inits)
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)], producer_name='livecam convert.py')
    m.ir_version = 8
    onnx.checker.check_model(m)
    return m

for src, dst in zip(sys.argv[1::2], sys.argv[2::2]):
    sd = load_pth(src)
    used = set()
    m = build(sd)
    onnx.save(m, dst)
    names = {i.name for i in m.graph.initializer}
    left = [k for k in sd if not k.endswith('num_batches_tracked') and k not in names]
    print(dst, 'params', len(sd), 'unused:', left)
